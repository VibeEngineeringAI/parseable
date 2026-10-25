/*
 * Parseable Server (C) 2022 - 2025 Parseable, Inc.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the
 * License, or (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 *
 */

use actix_web::http::StatusCode;
use actix_web::http::header::HeaderMap;
use actix_web::{HttpResponse, ResponseError};

#[derive(Debug, thiserror::Error)]
pub enum ParseHeaderError {
    #[error("Too many headers received. Limit is of 5 headers")]
    MaxHeadersLimitExceeded,
    #[error("A value passed in header can't be formatted to plain visible ASCII")]
    InvalidValue,
    #[error("Invalid Key was passed which terminated just after the end of prefix")]
    Emptykey,
    #[error("A key passed in header contains reserved char {0}")]
    SeperatorInKey(char),
    #[error("A value passed in header contains reserved char {0}")]
    SeperatorInValue(char),
    #[error("Stream name not found in header [x-p-stream]")]
    MissingStreamName,
    #[error("Tenant id not found in header [tenant]")]
    MissingTenantId,
    #[error("Invalid tenant id found in header [tenant]")]
    InvalidTenantId,
    #[error("Unexpected header found- {0}")]
    UnexpectedHeader(String),
}

impl ResponseError for ParseHeaderError {
    fn status_code(&self) -> StatusCode {
        StatusCode::BAD_REQUEST
    }

    fn error_response(&self) -> HttpResponse {
        HttpResponse::build(self.status_code()).body(self.to_string())
    }
}

/// Reads an optional header as visible-ASCII text.
///
/// A missing header is `Ok(None)`; a header that is present but cannot be
/// represented as visible ASCII is `Err(ParseHeaderError::InvalidValue)`.
/// The offending value is never included in the error.
pub fn optional_header_str<'a>(
    headers: &'a HeaderMap,
    name: &str,
) -> Result<Option<&'a str>, ParseHeaderError> {
    headers
        .get(name)
        .map(|value| value.to_str().map_err(|_| ParseHeaderError::InvalidValue))
        .transpose()
}

/// Failure while building headers for an outgoing (intra-cluster) request.
///
/// `Input` wraps a problem with the incoming client request and maps to 400.
/// `Internal` covers values the server stored or generated itself (cluster
/// secret hash, user id, node token) and maps to a generic 500; the static
/// string only names the field and never contains the value.
#[derive(Debug, thiserror::Error)]
pub enum HeaderBuildError {
    #[error(transparent)]
    Input(#[from] ParseHeaderError),
    #[error("Failed to build internal request headers")]
    Internal(&'static str),
}

impl ResponseError for HeaderBuildError {
    fn status_code(&self) -> StatusCode {
        match self {
            HeaderBuildError::Input(e) => e.status_code(),
            HeaderBuildError::Internal(_) => StatusCode::INTERNAL_SERVER_ERROR,
        }
    }

    fn error_response(&self) -> HttpResponse {
        HttpResponse::build(self.status_code()).body(self.to_string())
    }
}

fn generated_text_error(field: &'static str) -> HeaderBuildError {
    tracing::error!("failed to encode {field} as an intra-cluster header value");
    HeaderBuildError::Internal(field)
}

/// Encodes text the server stored or generated (user id, cluster secret hash,
/// node token, ...) as a header value for another node.
///
/// `HeaderValue::from_str` also accepts obs-text such as `é`, which the
/// receiving node then fails to read back with `to_str`, so the value must
/// also pass `to_str` here. Any failure is `HeaderBuildError::Internal`; the
/// value is never logged or included in the error. Opaque bytes copied from
/// the incoming request (Authorization, Cookie) must not go through this.
pub fn generated_text_header_value(
    value: &str,
    field: &'static str,
) -> Result<actix_web::http::header::HeaderValue, HeaderBuildError> {
    actix_web::http::header::HeaderValue::from_str(value)
        .ok()
        .filter(|value| value.to_str().is_ok())
        .ok_or_else(|| generated_text_error(field))
}

/// [`generated_text_header_value`] for a `reqwest` request.
pub fn generated_text_reqwest_header_value(
    value: &str,
    field: &'static str,
) -> Result<reqwest::header::HeaderValue, HeaderBuildError> {
    reqwest::header::HeaderValue::from_str(value)
        .ok()
        .filter(|value| value.to_str().is_ok())
        .ok_or_else(|| generated_text_error(field))
}

#[cfg(test)]
mod tests {
    use super::*;
    use actix_web::http::header::{HeaderName, HeaderValue};

    fn headers_with(name: &'static str, value: HeaderValue) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(HeaderName::from_static(name), value);
        headers
    }

    #[test]
    fn optional_header_str_missing_is_none() {
        let headers = HeaderMap::new();
        assert!(matches!(
            optional_header_str(&headers, "x-p-test"),
            Ok(None)
        ));
    }

    #[test]
    fn optional_header_str_valid_is_some() {
        let headers = headers_with("x-p-test", HeaderValue::from_static("value"));
        assert!(matches!(
            optional_header_str(&headers, "x-p-test"),
            Ok(Some("value"))
        ));
    }

    #[test]
    fn optional_header_str_non_ascii_is_invalid_value() {
        let headers = headers_with(
            "x-p-test",
            HeaderValue::from_bytes(b"caf\xc3\xa9").expect("obs-text is a valid header value"),
        );
        assert!(matches!(
            optional_header_str(&headers, "x-p-test"),
            Err(ParseHeaderError::InvalidValue)
        ));
    }

    #[test]
    fn header_build_error_status_codes() {
        assert_eq!(
            HeaderBuildError::Input(ParseHeaderError::InvalidTenantId).status_code(),
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            HeaderBuildError::Input(ParseHeaderError::InvalidValue).status_code(),
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            HeaderBuildError::Internal("node token").status_code(),
            StatusCode::INTERNAL_SERVER_ERROR
        );
    }

    #[test]
    fn header_build_error_internal_body_is_generic() {
        let err = HeaderBuildError::Internal("cluster secret hash");
        assert_eq!(err.to_string(), "Failed to build internal request headers");
    }

    // `from_str` alone accepts the non-ASCII values; the receiver's `to_str` doesn't
    const UNREADABLE_TEXT: [&str; 5] = ["josé", "用户", "c1\u{80}", "nl\nx", "del\u{7f}"];

    #[test]
    fn generated_text_header_value_accepts_visible_ascii() {
        for value in ["alice", "Basic dXNlcjpwYXNz", "a b\tc!~"] {
            let actix = generated_text_header_value(value, "user id").unwrap();
            assert_eq!(actix.to_str().unwrap(), value);
            let reqwest = generated_text_reqwest_header_value(value, "user id").unwrap();
            assert_eq!(reqwest.to_str().unwrap(), value);
        }
    }

    #[test]
    fn generated_text_header_value_rejects_unreadable_text_as_internal() {
        assert!(HeaderValue::from_str("josé").is_ok());
        for value in UNREADABLE_TEXT {
            for err in [
                generated_text_header_value(value, "user id").unwrap_err(),
                generated_text_reqwest_header_value(value, "user id").unwrap_err(),
            ] {
                assert!(matches!(err, HeaderBuildError::Internal("user id")));
                assert_eq!(err.status_code(), StatusCode::INTERNAL_SERVER_ERROR);
                let body = err.to_string();
                assert!(!body.contains(value));
                assert!(!format!("{err:?}").contains(value));
            }
        }
    }
}
