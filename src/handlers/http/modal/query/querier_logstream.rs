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

use core::str;
use std::{collections::HashMap, fs};

use actix_web::http::StatusCode;
use actix_web::http::header::{HeaderMap, HeaderName, HeaderValue};
use actix_web::{
    HttpRequest, Responder,
    web::{self, Path},
};
use bytes::Bytes;
use chrono::Utc;
use tokio::sync::Mutex;
use tracing::{error, warn};

pub static CREATE_STREAM_LOCK: Mutex<()> = Mutex::const_new(());

use crate::handlers::http::middleware::{CLUSTER_SECRET, CLUSTER_SECRET_HEADER};
use crate::hottier::GLOBAL_HOTTIER;
use crate::parseable::DEFAULT_TENANT;
use crate::utils::get_user_from_request;
use crate::utils::header_parsing::{
    HeaderBuildError, ParseHeaderError, generated_text_header_value, optional_header_str,
};
use crate::{
    handlers::{
        UPDATE_STREAM_KEY,
        http::{
            base_path_without_preceding_slash,
            cluster::{
                self, INTRA_CLUSTER_USERID, fetch_daily_stats, fetch_stats_from_ingestors,
                sync_streams_with_ingestors,
                utils::{IngestionStats, QueriedStats, StorageStats, merge_queried_stats},
            },
            logstream::error::StreamError,
            modal::{NodeMetadata, NodeType},
        },
    },
    parseable::{PARSEABLE, StreamNotFound},
    stats,
    storage::{ObjectStoreFormat, StreamType},
    utils::get_tenant_id_from_request,
};
const STATS_DATE_QUERY_PARAM: &str = "date";

pub async fn delete(
    req: HttpRequest,
    stream_name: Path<String>,
) -> Result<impl Responder, StreamError> {
    let stream_name = stream_name.into_inner();
    let tenant_id = get_tenant_id_from_request(&req)?;
    // if the stream not found in memory map,
    //check if it exists in the storage
    //create stream and schema from storage
    if !PARSEABLE.streams.contains(&stream_name, &tenant_id)
        && !PARSEABLE
            .create_stream_and_schema_from_storage(&stream_name, &tenant_id)
            .await
            .unwrap_or(false)
    {
        return Err(StreamNotFound(stream_name.clone()).into());
    }

    let objectstore = PARSEABLE.storage.get_object_store();
    // Delete from storage
    objectstore.delete_stream(&stream_name, &tenant_id).await?;
    let stream_dir = PARSEABLE.get_or_create_stream(&stream_name, &tenant_id);
    if let Err(err) = fs::remove_dir_all(&stream_dir.data_path) {
        warn!(
            "failed to delete local data for stream {} with error {err}. Clean {} manually",
            stream_name,
            stream_dir.data_path.to_string_lossy()
        )
    }

    if let Some(hot_tier_manager) = GLOBAL_HOTTIER.get()
        && hot_tier_manager.check_stream_hot_tier_exists(&stream_name, &tenant_id)
    {
        hot_tier_manager
            .delete_hot_tier(&stream_name, &tenant_id)
            .await?;
    }

    let ingestor_metadata: Vec<NodeMetadata> =
        cluster::get_node_info(NodeType::Ingestor, &tenant_id)
            .await
            .map_err(|err| {
                error!("Fatal: failed to get ingestor info: {:?}", err);
                err
            })?;

    for ingestor in ingestor_metadata {
        let url = format!(
            "{}{}/logstream/{}/sync",
            ingestor.domain_name,
            base_path_without_preceding_slash(),
            stream_name
        );

        // delete the stream
        cluster::send_stream_delete_request(&url, ingestor.clone()).await?;
    }

    // Delete from memory
    PARSEABLE.streams.delete(&stream_name, &tenant_id);
    stats::delete_stats(&stream_name, "json", &tenant_id)
        .unwrap_or_else(|e| warn!("failed to delete stats for stream {}: {:?}", stream_name, e));

    Ok((format!("log stream {stream_name} deleted"), StatusCode::OK))
}

pub async fn put_stream(
    req: HttpRequest,
    stream_name: Path<String>,
    body: Bytes,
) -> Result<impl Responder, StreamError> {
    let stream_name = stream_name.into_inner();
    let tenant_id = get_tenant_id_from_request(&req)?;
    let is_update =
        optional_header_str(req.headers(), UPDATE_STREAM_KEY)?.is_some_and(|value| value == "true");

    // Build the forwarding headers before mutating the stream so that a bad
    // header can't leave the stream created locally but never synced.
    let intracluster_headers = match CLUSTER_SECRET.get() {
        Some((_, hash)) => {
            let userid = get_user_from_request(&req).map_err(|_| StreamError::Custom {
                msg: "Unauthorized".to_owned(),
                status: StatusCode::UNAUTHORIZED,
            })?;
            intracluster_stream_headers(hash, &tenant_id, &userid)?
        }
        None => Vec::new(),
    };
    check_sync_userid_fallback(
        req.headers(),
        &intracluster_headers,
        &PARSEABLE.options.username,
    )?;

    let _guard = CREATE_STREAM_LOCK.lock().await;
    let mut headers = PARSEABLE
        .create_update_stream(req.headers(), &body, &stream_name, &tenant_id)
        .await?;
    for (name, value) in intracluster_headers {
        headers.insert(name, value);
    }
    match sync_streams_with_ingestors(headers, body, &stream_name, &tenant_id).await {
        Ok(()) => {}
        // checked above, so this is a server bug rather than a sync failure
        Err(e @ StreamError::HeaderBuild(_)) => return Err(e),
        Err(e) => tracing::error!("{e}"),
    }

    if is_update {
        Ok(("Log stream updated", StatusCode::OK))
    } else {
        Ok(("Log stream created", StatusCode::OK))
    }
}

/// Headers that authenticate a forwarded stream create/update as an
/// intra-cluster request. A tenant that can't be encoded is a client error;
/// a cluster secret hash or user id that can't be encoded is internal.
fn intracluster_stream_headers(
    hash: &str,
    tenant_id: &Option<String>,
    userid: &str,
) -> Result<Vec<(HeaderName, HeaderValue)>, HeaderBuildError> {
    let tenant = HeaderValue::from_str(tenant_id.as_deref().unwrap_or(DEFAULT_TENANT))
        .map_err(|_| HeaderBuildError::Input(ParseHeaderError::InvalidTenantId))?;
    let hash = generated_text_header_value(hash, "cluster secret hash")?;
    let userid = generated_text_header_value(userid, "user id")?;
    Ok(vec![
        (HeaderName::from_static(CLUSTER_SECRET_HEADER), hash),
        (HeaderName::from_static("intra-cluster-tenant"), tenant),
        (HeaderName::from_static(INTRA_CLUSTER_USERID), userid),
    ])
}

/// `sync_streams_with_ingestors` sends the configured username as the user id
/// when the forwarded headers carry none. Check that it can be encoded before
/// the stream is mutated, using the same helper so the two can't drift.
fn check_sync_userid_fallback(
    req_headers: &HeaderMap,
    intracluster_headers: &[(HeaderName, HeaderValue)],
    username: &str,
) -> Result<(), HeaderBuildError> {
    let has_userid = req_headers.contains_key(INTRA_CLUSTER_USERID)
        || intracluster_headers
            .iter()
            .any(|(name, _)| name == INTRA_CLUSTER_USERID);
    cluster::fallback_intracluster_userid(has_userid, username).map(|_| ())
}

pub async fn get_stats(
    req: HttpRequest,
    stream_name: Path<String>,
) -> Result<impl Responder, StreamError> {
    let stream_name = stream_name.into_inner();
    let tenant_id = get_tenant_id_from_request(&req)?;
    let query_map = web::Query::<HashMap<String, String>>::from_query(req.query_string())
        .map_err(|_| StreamError::InvalidQueryParameter(STATS_DATE_QUERY_PARAM.to_string()))?;
    let date = if query_map.is_empty() {
        None
    } else {
        Some(
            query_map
                .get(STATS_DATE_QUERY_PARAM)
                .ok_or_else(|| {
                    StreamError::InvalidQueryParameter(STATS_DATE_QUERY_PARAM.to_string())
                })?
                .as_str(),
        )
    };
    Ok(web::Json(
        get_stats_internal(&stream_name, &tenant_id, date).await?,
    ))
}

/// Shared statistics implementation for HTTP handlers and in-process callers.
pub async fn get_stats_internal(
    stream_name: &str,
    tenant_id: &Option<String>,
    date: Option<&str>,
) -> Result<serde_json::Value, StreamError> {
    // if the stream not found in memory map,
    //check if it exists in the storage
    //create stream and schema from storage
    if !PARSEABLE.streams.contains(stream_name, tenant_id)
        && !PARSEABLE
            .create_stream_and_schema_from_storage(stream_name, tenant_id)
            .await
            .unwrap_or(false)
    {
        return Err(StreamNotFound(stream_name.to_owned()).into());
    }

    if let Some(date_value) = date
        && !date_value.is_empty()
    {
        let obs = PARSEABLE
            .metastore
            .get_all_stream_jsons(stream_name, None, tenant_id, false)
            .await?;

        let mut stream_jsons = Vec::new();
        for ob in obs {
            let stream_metadata: ObjectStoreFormat = match serde_json::from_slice(&ob) {
                Ok(d) => d,
                Err(e) => {
                    error!("Failed to parse stream metadata: {:?}", e);
                    continue;
                }
            };
            stream_jsons.push(stream_metadata);
        }

        let stats = fetch_daily_stats(date_value, &stream_jsons)?;

        let stats = serde_json::to_value(stats)?;

        return Ok(stats);
    }

    let stats = stats::get_current_stats(stream_name, "json", tenant_id)
        .ok_or_else(|| StreamNotFound(stream_name.to_owned()))?;

    let ingestor_stats = if PARSEABLE
        .get_stream(stream_name, tenant_id)
        .is_ok_and(|stream| stream.get_stream_type() == StreamType::UserDefined)
    {
        Some(fetch_stats_from_ingestors(stream_name, tenant_id).await?)
    } else {
        None
    };

    let time = Utc::now();

    let stats = {
        let ingestion_stats = IngestionStats::new(
            stats.current_stats.events,
            stats.current_stats.ingestion,
            stats.lifetime_stats.events,
            stats.lifetime_stats.ingestion,
            stats.deleted_stats.events,
            stats.deleted_stats.ingestion,
            "json",
        );
        let storage_stats = StorageStats::new(
            stats.current_stats.storage,
            stats.lifetime_stats.storage,
            stats.deleted_stats.storage,
            "parquet",
        );

        QueriedStats::new(stream_name, time, ingestion_stats, storage_stats)
    };

    let stats = if let Some(mut ingestor_stats) = ingestor_stats {
        ingestor_stats.push(stats);
        merge_queried_stats(ingestor_stats)
            .map_err(|e| StreamError::Anyhow(anyhow::Error::msg(e.to_string())))?
    } else {
        stats
    };

    let stats = serde_json::to_value(stats)?;

    Ok(stats)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn intracluster_stream_headers_carry_secret_tenant_and_user() {
        let headers = intracluster_stream_headers("hash", &Some("acme".to_owned()), "alice")
            .expect("valid values build headers");
        let get = |name: &str| {
            headers
                .iter()
                .find(|(key, _)| key == name)
                .map(|(_, value)| value.to_str().unwrap().to_owned())
        };
        assert_eq!(get(CLUSTER_SECRET_HEADER).as_deref(), Some("hash"));
        assert_eq!(get("intra-cluster-tenant").as_deref(), Some("acme"));
        assert_eq!(get("intra-cluster-userid").as_deref(), Some("alice"));
    }

    #[test]
    fn intracluster_stream_headers_default_missing_tenant() {
        let headers = intracluster_stream_headers("hash", &None, "alice").unwrap();
        assert!(
            headers
                .iter()
                .any(|(key, value)| key == "intra-cluster-tenant" && value == DEFAULT_TENANT)
        );
    }

    #[test]
    fn intracluster_stream_headers_reject_invalid_tenant_as_input() {
        let err = intracluster_stream_headers("hash", &Some("bad\ntenant".to_owned()), "alice")
            .unwrap_err();
        assert!(matches!(
            err,
            HeaderBuildError::Input(ParseHeaderError::InvalidTenantId)
        ));
        assert_eq!(
            actix_web::ResponseError::status_code(&StreamError::from(err)),
            StatusCode::BAD_REQUEST
        );
    }

    #[test]
    fn intracluster_stream_headers_reject_invalid_generated_values_as_internal() {
        let err = intracluster_stream_headers("se\ncret", &None, "alice").unwrap_err();
        assert!(matches!(
            err,
            HeaderBuildError::Internal("cluster secret hash")
        ));
        assert!(!err.to_string().contains("se\ncret"));
        let err = intracluster_stream_headers("hash", &None, "al\rice").unwrap_err();
        assert!(matches!(err, HeaderBuildError::Internal("user id")));
        assert_eq!(
            actix_web::ResponseError::status_code(&StreamError::from(err)),
            StatusCode::INTERNAL_SERVER_ERROR
        );
    }

    // `HeaderValue::from_str` accepts these but the ingestor's `to_str` doesn't
    const UNREADABLE_TEXT: [&str; 3] = ["josé", "用户", "ctl\u{1}"];

    fn assert_internal_500(err: HeaderBuildError, field: &str, value: &str) {
        assert!(matches!(err, HeaderBuildError::Internal(f) if f == field));
        assert!(!err.to_string().contains(value));
        assert_eq!(
            actix_web::ResponseError::status_code(&StreamError::from(err)),
            StatusCode::INTERNAL_SERVER_ERROR
        );
    }

    #[test]
    fn intracluster_stream_headers_reject_unreadable_generated_text() {
        for value in UNREADABLE_TEXT {
            let err = intracluster_stream_headers(value, &None, "alice").unwrap_err();
            assert_internal_500(err, "cluster secret hash", value);
            let err = intracluster_stream_headers("hash", &None, value).unwrap_err();
            assert_internal_500(err, "user id", value);
        }
    }

    fn userid_header(value: &'static str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(
            HeaderName::from_static(INTRA_CLUSTER_USERID),
            HeaderValue::from_static(value),
        );
        headers
    }

    #[test]
    fn sync_userid_fallback_accepts_valid_username() {
        check_sync_userid_fallback(&HeaderMap::new(), &[], "admin").unwrap();
    }

    #[test]
    fn sync_userid_fallback_rejects_unreadable_username_before_mutation() {
        // no cluster secret and no user id on the request: the sync would send
        // the configured username, so it must fail here before the stream changes
        for username in ["ad\nmin", "ad\u{7f}min", "josé", "用户"] {
            let err = check_sync_userid_fallback(&HeaderMap::new(), &[], username).unwrap_err();
            assert_internal_500(err, "configured username", username);
        }
    }

    #[test]
    fn sync_userid_fallback_skipped_when_userid_present() {
        // the sync keeps an already-present user id, so the username is never sent
        check_sync_userid_fallback(&userid_header("alice"), &[], "ad\nmin").unwrap();
        let intracluster = intracluster_stream_headers("hash", &None, "alice").unwrap();
        check_sync_userid_fallback(&HeaderMap::new(), &intracluster, "josé").unwrap();
    }
}
