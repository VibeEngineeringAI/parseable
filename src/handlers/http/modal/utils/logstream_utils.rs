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

use actix_web::http::header::HeaderMap;

use crate::{
    event::format::LogSource,
    handlers::{
        CUSTOM_PARTITION_KEY, DATASET_LABELS_KEY, DATASET_TAG_KEY, DATASET_TAGS_KEY, DatasetTag,
        INFER_TIMESTAMP_KEY, LOG_SOURCE_KEY, STATIC_SCHEMA_FLAG, STREAM_TYPE_KEY,
        TELEMETRY_TYPE_KEY, TIME_PARTITION_LIMIT_KEY, TelemetryType, UPDATE_STREAM_KEY,
        parse_dataset_labels, parse_dataset_tags,
    },
    storage::StreamType,
    utils::header_parsing::{ParseHeaderError, optional_header_str},
};

#[derive(Debug)]
pub struct PutStreamHeaders {
    pub time_partition_limit: String,
    pub custom_partition: Option<String>,
    pub static_schema_flag: bool,
    pub update_stream_flag: bool,
    pub stream_type: StreamType,
    pub log_source: LogSource,
    pub telemetry_type: TelemetryType,
    pub telemetry_type_set: bool,
    pub dataset_tags: Vec<DatasetTag>,
    pub dataset_labels: Vec<String>,
    pub infer_timestamp: bool,
    pub infer_timestamp_set: bool,
}

impl Default for PutStreamHeaders {
    fn default() -> Self {
        Self {
            time_partition_limit: String::default(),
            custom_partition: None,
            static_schema_flag: false,
            update_stream_flag: false,
            stream_type: StreamType::default(),
            log_source: LogSource::default(),
            telemetry_type: TelemetryType::default(),
            telemetry_type_set: false,
            dataset_tags: Vec::new(),
            dataset_labels: Vec::new(),
            infer_timestamp: true,
            infer_timestamp_set: false,
        }
    }
}

impl TryFrom<&HeaderMap> for PutStreamHeaders {
    type Error = ParseHeaderError;

    /// Parses the stream creation/update headers.
    ///
    /// Absent headers fall back to their defaults, but a present header whose
    /// value is not visible ASCII is rejected instead of panicking or being
    /// silently treated as absent.
    fn try_from(headers: &HeaderMap) -> Result<Self, Self::Error> {
        let time_partition_limit = optional_header_str(headers, TIME_PARTITION_LIMIT_KEY)?
            .unwrap_or_default()
            .to_string();
        let custom_partition =
            optional_header_str(headers, CUSTOM_PARTITION_KEY)?.map(str::to_string);
        let static_schema_flag =
            optional_header_str(headers, STATIC_SCHEMA_FLAG)?.is_some_and(|v| v == "true");
        let update_stream_flag =
            optional_header_str(headers, UPDATE_STREAM_KEY)?.is_some_and(|v| v == "true");
        // `StreamType::from` panics on unknown values, so match here and
        // reject anything else with a 400 that does not echo the value.
        let stream_type = match optional_header_str(headers, STREAM_TYPE_KEY)? {
            None => StreamType::default(),
            Some("UserDefined") => StreamType::UserDefined,
            Some("Internal") => StreamType::Internal,
            Some(_) => {
                return Err(ParseHeaderError::UnexpectedHeader(
                    STREAM_TYPE_KEY.to_string(),
                ));
            }
        };
        let log_source =
            optional_header_str(headers, LOG_SOURCE_KEY)?.map_or(LogSource::default(), Into::into);

        // Track raw header presence first so a present-but-unparseable header
        // (non-UTF-8 bytes, etc.) still trips downstream validation gates
        // instead of silently being treated as absent.
        let infer_timestamp_set = headers.contains_key(INFER_TIMESTAMP_KEY);
        let infer_timestamp_value = headers
            .get(INFER_TIMESTAMP_KEY)
            .and_then(|v| v.to_str().ok());
        let telemetry_type_set = headers.contains_key(TELEMETRY_TYPE_KEY);
        let telemetry_type_value = headers
            .get(TELEMETRY_TYPE_KEY)
            .and_then(|v| v.to_str().ok());
        Ok(PutStreamHeaders {
            time_partition_limit,
            custom_partition,
            static_schema_flag,
            update_stream_flag,
            stream_type,
            log_source,
            telemetry_type: telemetry_type_value.map_or(TelemetryType::Logs, TelemetryType::from),
            telemetry_type_set,
            dataset_tags: headers
                .get(DATASET_TAGS_KEY)
                .or_else(|| headers.get(DATASET_TAG_KEY))
                .and_then(|v| v.to_str().ok())
                .map(parse_dataset_tags)
                .unwrap_or_default(),
            dataset_labels: headers
                .get(DATASET_LABELS_KEY)
                .and_then(|v| v.to_str().ok())
                .map(parse_dataset_labels)
                .unwrap_or_default(),
            infer_timestamp: infer_timestamp_value.is_none_or(|v| !v.eq_ignore_ascii_case("false")),
            infer_timestamp_set,
        })
    }
}

#[cfg(test)]
mod tests {
    use actix_web::http::header::{HeaderMap, HeaderName, HeaderValue};

    use super::PutStreamHeaders;
    use crate::{
        event::format::LogSource,
        handlers::{
            CUSTOM_PARTITION_KEY, INFER_TIMESTAMP_KEY, LOG_SOURCE_KEY, STATIC_SCHEMA_FLAG,
            STREAM_TYPE_KEY, TELEMETRY_TYPE_KEY, TIME_PARTITION_LIMIT_KEY, TelemetryType,
            UPDATE_STREAM_KEY,
        },
        storage::StreamType,
        utils::header_parsing::ParseHeaderError,
    };

    fn parse(headers: &HeaderMap) -> PutStreamHeaders {
        PutStreamHeaders::try_from(headers).expect("headers should parse")
    }

    fn headers_with(name: &'static str, value: HeaderValue) -> HeaderMap {
        let mut map = HeaderMap::new();
        map.insert(HeaderName::from_static(name), value);
        map
    }

    fn headers_with_infer(value: &str) -> HeaderMap {
        headers_with(INFER_TIMESTAMP_KEY, HeaderValue::from_str(value).unwrap())
    }

    fn non_utf8() -> HeaderValue {
        HeaderValue::from_bytes(&[0xff, 0xfe]).unwrap()
    }

    /// Headers whose value used to be `to_str().unwrap()`ed.
    const STRICT_HEADERS: [&str; 6] = [
        TIME_PARTITION_LIMIT_KEY,
        CUSTOM_PARTITION_KEY,
        STATIC_SCHEMA_FLAG,
        UPDATE_STREAM_KEY,
        STREAM_TYPE_KEY,
        LOG_SOURCE_KEY,
    ];

    #[test]
    fn defaults_to_true_when_header_absent() {
        let headers = HeaderMap::new();
        let parsed = parse(&headers);
        assert!(parsed.infer_timestamp);
        assert!(!parsed.infer_timestamp_set);
    }

    #[test]
    fn parses_false_value() {
        let parsed = parse(&headers_with_infer("false"));
        assert!(!parsed.infer_timestamp);
        assert!(parsed.infer_timestamp_set);
    }

    #[test]
    fn parses_true_value() {
        let parsed = parse(&headers_with_infer("true"));
        assert!(parsed.infer_timestamp);
        assert!(parsed.infer_timestamp_set);
    }

    #[test]
    fn case_insensitive_false() {
        let parsed = parse(&headers_with_infer("FALSE"));
        assert!(!parsed.infer_timestamp);
        assert!(parsed.infer_timestamp_set);
    }

    #[test]
    fn unknown_value_treated_as_true() {
        // Anything not matching "false" (case-insensitive) keeps the default behavior
        // of inferring timestamps; flag is still considered explicitly set.
        let parsed = parse(&headers_with_infer("yes"));
        assert!(parsed.infer_timestamp);
        assert!(parsed.infer_timestamp_set);
    }

    #[test]
    fn telemetry_type_set_flag_tracks_header_presence() {
        // Header absent -> flag is false, value defaults to Logs.
        let parsed = parse(&HeaderMap::new());
        assert!(!parsed.telemetry_type_set);
        assert_eq!(parsed.telemetry_type, TelemetryType::Logs);

        // Header present -> flag is true, value parsed from header.
        let mut h = HeaderMap::new();
        h.insert(
            HeaderName::from_static(TELEMETRY_TYPE_KEY),
            HeaderValue::from_static("metrics"),
        );
        let parsed = parse(&h);
        assert!(parsed.telemetry_type_set);
        assert_eq!(parsed.telemetry_type, TelemetryType::Metrics);
    }

    #[test]
    fn infer_timestamp_set_when_header_present_but_non_utf8() {
        // A header with non-UTF-8 bytes must still be treated as "set" so
        // downstream validation (otel-metrics-only, create-only) sees it and
        // can reject it. Previously the parsed Option<&str> was used as the
        // presence signal, letting non-UTF-8 silently bypass validation.
        let mut h = HeaderMap::new();
        h.insert(
            HeaderName::from_static(INFER_TIMESTAMP_KEY),
            HeaderValue::from_bytes(&[0xff, 0xfe]).unwrap(),
        );
        let parsed = parse(&h);
        assert!(parsed.infer_timestamp_set);
        // Value couldn't be parsed -> falls back to default (true), but the
        // _set flag still ensures downstream gates fire.
        assert!(parsed.infer_timestamp);
    }

    #[test]
    fn telemetry_type_set_when_header_present_but_non_utf8() {
        let mut h = HeaderMap::new();
        h.insert(
            HeaderName::from_static(TELEMETRY_TYPE_KEY),
            HeaderValue::from_bytes(&[0xff, 0xfe]).unwrap(),
        );
        let parsed = parse(&h);
        assert!(parsed.telemetry_type_set);
        assert_eq!(parsed.telemetry_type, TelemetryType::Logs);
    }

    #[test]
    fn absent_strict_headers_use_defaults() {
        let parsed = parse(&HeaderMap::new());
        assert_eq!(parsed.time_partition_limit, "");
        assert_eq!(parsed.custom_partition, None);
        assert!(!parsed.static_schema_flag);
        assert!(!parsed.update_stream_flag);
        assert_eq!(parsed.stream_type, StreamType::UserDefined);
        assert_eq!(parsed.log_source, LogSource::Json);
    }

    #[test]
    fn valid_strict_headers_are_parsed() {
        let mut h = HeaderMap::new();
        for (name, value) in [
            (TIME_PARTITION_LIMIT_KEY, "30d"),
            (CUSTOM_PARTITION_KEY, "region"),
            (STATIC_SCHEMA_FLAG, "true"),
            (UPDATE_STREAM_KEY, "true"),
            (STREAM_TYPE_KEY, "Internal"),
            (LOG_SOURCE_KEY, "otel-logs"),
        ] {
            h.insert(
                HeaderName::from_static(name),
                HeaderValue::from_static(value),
            );
        }
        let parsed = parse(&h);
        assert_eq!(parsed.time_partition_limit, "30d");
        assert_eq!(parsed.custom_partition.as_deref(), Some("region"));
        assert!(parsed.static_schema_flag);
        assert!(parsed.update_stream_flag);
        assert_eq!(parsed.stream_type, StreamType::Internal);
        assert_eq!(parsed.log_source, LogSource::OtelLogs);
    }

    #[test]
    fn boolean_flags_require_exact_true() {
        for flag in [STATIC_SCHEMA_FLAG, UPDATE_STREAM_KEY] {
            for value in ["TRUE", "yes", "false", ""] {
                let parsed = parse(&headers_with(flag, HeaderValue::from_static(value)));
                assert!(
                    !parsed.static_schema_flag && !parsed.update_stream_flag,
                    "{flag}={value:?} must not enable the flag"
                );
            }
        }
    }

    #[test]
    fn custom_log_source_is_preserved() {
        let parsed = parse(&headers_with(
            LOG_SOURCE_KEY,
            HeaderValue::from_static("Syslog"),
        ));
        assert_eq!(parsed.log_source, LogSource::Custom("syslog".to_string()));
    }

    #[test]
    fn malformed_strict_header_is_rejected() {
        for name in STRICT_HEADERS {
            let result = PutStreamHeaders::try_from(&headers_with(name, non_utf8()));
            assert!(
                matches!(result, Err(ParseHeaderError::InvalidValue)),
                "{name} with non-UTF-8 bytes must be rejected, got {result:?}"
            );
        }
    }

    #[test]
    fn unknown_stream_type_is_rejected_without_echo() {
        let result = PutStreamHeaders::try_from(&headers_with(
            STREAM_TYPE_KEY,
            HeaderValue::from_static("secret-ish-value"),
        ));
        let err = result.expect_err("unknown stream type must be rejected");
        assert!(matches!(err, ParseHeaderError::UnexpectedHeader(_)));
        assert!(!err.to_string().contains("secret-ish-value"));
    }
}
