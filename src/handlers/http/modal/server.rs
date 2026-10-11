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

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex, Once};
use std::thread;

use crate::analytics;
use crate::handlers;
use crate::handlers::http::about;
use crate::handlers::http::alerts;
use crate::handlers::http::apikeys;
use crate::handlers::http::base_path;
use crate::handlers::http::demo_data::get_demo_data;
use crate::handlers::http::health_check;
use crate::handlers::http::max_event_payload_size;
use crate::handlers::http::middleware::IntraClusterRequest;
use crate::handlers::http::otel_generator::{
    get_otel_generator_status, start_otel_generator, stop_otel_generator,
};
use crate::handlers::http::prism_base_path;
use crate::handlers::http::query;
use crate::handlers::http::query_context;
use crate::handlers::http::resource_check;
use crate::handlers::http::targets;
use crate::handlers::http::users::dashboards;
use crate::handlers::http::users::filters;
use crate::hottier::GLOBAL_HOTTIER;
use crate::hottier::HotTierManager;
use crate::hottier::HotTierMessage;
use crate::hottier::hottier_runtime;
use crate::metrics;
use crate::migration;
use crate::option::UiRoot;
use crate::storage;
use crate::storage::field_stats::get_dataset_stats;
use crate::sync;

use crate::handlers::http::alert_target_policy;
use actix_web::Resource;
use actix_web::Scope;
use actix_web::body::MessageBody;
use actix_web::dev::{ServiceFactory, ServiceRequest, ServiceResponse};
use actix_web::http::StatusCode;
use actix_web::http::header::{CACHE_CONTROL, HeaderValue, LOCATION};
use actix_web::middleware::{Next, from_fn};
use actix_web::web;
use actix_web::web::resource;
use actix_web::{HttpRequest, HttpResponse};
use actix_web_prometheus::PrometheusMetrics;
use actix_web_static_files::{ResourceFiles, ResourceFilesCollection};
use async_trait::async_trait;
use bytes::Bytes;
use tokio::sync::mpsc;
use tokio::sync::oneshot;

use crate::{
    handlers::http::{
        self, ingest, logstream,
        middleware::{DisAllowRootUser, RouteExt},
        oidc, role, traces,
    },
    parseable::PARSEABLE,
    rbac::role::Action,
};

// use super::generate;
use super::ParseableServer;
use super::load_on_init;
use super::{generate, generate_next};

pub struct Server;

#[async_trait]
impl ParseableServer for Server {
    fn configure_routes(config: &mut web::ServiceConfig) {
        // there might be a bug in the configure routes method
        config
            .service(crate::handlers::http::promql::scope())
            .service(
                web::scope(&base_path())
                    .service(Self::get_query_factory())
                    .service(Self::get_query_context_factory())
                    .service(Self::get_ingest_factory().wrap(from_fn(
                        resource_check::check_resource_utilization_middleware,
                    )))
                    .service(Self::get_liveness_factory())
                    .service(Self::get_readiness_factory())
                    .service(Self::get_about_factory())
                    .service(Self::get_logstream_webscope())
                    .service(Self::get_user_webscope())
                    .service(Self::get_users_webscope())
                    .service(Self::get_dashboards_webscope())
                    .service(Self::get_filters_webscope())
                    .service(Self::get_oauth_webscope())
                    .service(Self::get_user_role_webscope())
                    .service(Self::get_roles_webscope())
                    .service(Self::get_counts_webscope())
                    .service(Self::get_alerts_webscope())
                    .service(Self::get_targets_webscope())
                    .service(Self::get_alert_target_policy())
                    .service(Self::get_metrics_webscope())
                    .service(Self::get_demo_data_webscope()),
            )
            .service(
                web::scope(&prism_base_path())
                    .service(Server::get_prism_home())
                    .service(Server::get_llm_webscope())
                    .service(Server::get_prism_logstream())
                    .service(Server::get_prism_datasets())
                    .service(Server::get_apikeys_webscope())
                    .service(Self::get_otel_generator_webscope())
                    .service(Self::get_traces_webscope())
                    .service(Self::get_dataset_stats_webscope()),
            )
            .service(Self::get_ingest_otel_factory().wrap(from_fn(
                resource_check::check_resource_utilization_middleware,
            )))
            .configure(Self::configure_ui);
    }

    async fn load_metadata(&self) -> anyhow::Result<Option<Bytes>> {
        //TODO: removed file migration
        //deprecated support for deployments < v1.0.0
        let mut parseable_json = PARSEABLE.validate_storage().await?;
        migration::run_metadata_migration(&PARSEABLE, &mut parseable_json, &None).await?;

        Ok(parseable_json)
    }

    // configure the server and start an instance of the single server setup
    async fn init(
        &self,
        prometheus: &PrometheusMetrics,
        shutdown_rx: oneshot::Receiver<()>,
    ) -> anyhow::Result<()> {
        migration::run_migration(&PARSEABLE).await?;

        // load on init
        load_on_init().await?;

        storage::retention::load_retention_from_global();

        // Reserve the startup backlog before periodic sync can claim files.
        let (startup_snapshot_tx, startup_snapshot_rx) = std::sync::mpsc::channel();
        thread::spawn(move || sync::sync_start_and_signal(startup_snapshot_tx));

        if let Some(htm) = PARSEABLE
            .options
            .hot_tier_storage_path
            .as_ref()
            .map(|hot_tier_path| {
                // start hottier runtime
                let (sender, receiver): (
                    mpsc::UnboundedSender<HotTierMessage>,
                    mpsc::UnboundedReceiver<HotTierMessage>,
                ) = mpsc::unbounded_channel();
                std::thread::spawn(|| hottier_runtime(receiver));

                // set global hottier

                GLOBAL_HOTTIER.get_or_init(|| HotTierManager::new(hot_tier_path, sender))
            })
        {
            htm.start_all_tasks().await;
        }

        // Conversion may continue in startup sync; periodic sync only waits
        // for the short processing-file snapshot.
        let (cancel_tx, cancel_rx) = oneshot::channel();
        thread::spawn(move || {
            if startup_snapshot_rx.recv().is_err() {
                tracing::warn!(
                    "Startup sync exited before signaling snapshot completion; starting periodic sync"
                );
            }
            sync::handler(cancel_rx)
        });

        if PARSEABLE.options.send_analytics {
            analytics::init_analytics_scheduler()?;
        }

        tokio::spawn(handlers::livetail::server());
        tokio::spawn(handlers::airplane::server());

        let result = self
            .start(shutdown_rx, prometheus.clone(), PARSEABLE.options.openid())
            .await;
        // Cancel sync jobs
        cancel_tx.send(()).expect("Cancellation should not fail");
        return result;
    }
}

impl Server {
    pub fn get_llm_webscope() -> Scope {
        web::scope("/llm")
            .service(
                web::resource("/tools/list").route(
                    web::get()
                        .to(crate::tool_catalog::list_tool_registry)
                        .authorize(Action::Query),
                ),
            )
            .service(
                web::resource("/tools/call").route(
                    web::post()
                        .to(crate::tool_executor::call_tool_registry)
                        .authorize(Action::Query),
                ),
            )
    }

    pub fn get_prism_home() -> Scope {
        web::scope("/home")
            .service(web::resource("").route(web::get().to(http::prism_home::home_api)))
            .service(web::resource("/search").route(web::get().to(http::prism_home::home_search)))
    }

    pub fn get_prism_logstream() -> Scope {
        web::scope("/logstream").service(
            web::scope("/{logstream}").service(
                web::resource("/info").route(
                    web::get()
                        .to(http::prism_logstream::get_info)
                        .authorize_for_resource(Action::GetStreamInfo)
                        .authorize_for_resource(Action::GetStats)
                        .authorize_for_resource(Action::GetRetention),
                ),
            ),
        )
    }

    pub fn get_prism_datasets() -> Scope {
        web::scope("/datasets").route(
            "",
            web::post()
                .to(http::prism_logstream::post_datasets)
                .authorize_for_resource(Action::GetStreamInfo)
                .authorize_for_resource(Action::GetStats)
                .authorize_for_resource(Action::GetRetention),
        )
    }

    pub fn get_apikeys_webscope() -> Scope {
        web::scope("/apikeys")
            .service(
                resource("")
                    .route(
                        web::post()
                            .to(apikeys::create_api_key)
                            .authorize(Action::All),
                    )
                    .route(web::get().to(apikeys::list_api_keys).authorize(Action::All)),
            )
            .service(
                resource("/validate").route(
                    web::post()
                        .to(apikeys::validate_api_key)
                        .authorize(Action::All),
                ),
            )
            .service(
                resource("/{key_id}")
                    .route(web::get().to(apikeys::get_api_key).authorize(Action::All))
                    .route(
                        web::delete()
                            .to(apikeys::delete_api_key)
                            .authorize(Action::All),
                    ),
            )
    }

    pub fn get_demo_data_webscope() -> Scope {
        web::scope("/demodata").service(web::resource("").route(web::get().to(get_demo_data)))
    }

    pub fn get_otel_generator_webscope() -> Scope {
        web::scope("/otel_generator").service(Self::get_otel_generator_resource())
    }

    pub fn get_otel_generator_ingest_webscope() -> Scope {
        web::scope("/otel_generator")
            .service(Self::get_otel_generator_resource().wrap(IntraClusterRequest))
    }

    fn get_otel_generator_resource() -> Resource {
        web::resource("")
            .route(
                web::get()
                    .to(get_otel_generator_status)
                    .authorize(Action::Ingest),
            )
            .route(
                web::post()
                    .to(start_otel_generator)
                    .authorize(Action::Ingest),
            )
            .route(
                web::delete()
                    .to(stop_otel_generator)
                    .authorize(Action::Ingest),
            )
    }

    pub fn get_traces_webscope() -> Scope {
        web::scope("/services/traces")
            .service(
                web::resource("/list")
                    .route(web::post().to(traces::list_traces).authorize(Action::Query)),
            )
            .service(
                web::resource("/detail").route(
                    web::post()
                        .to(traces::get_trace_detail)
                        .authorize(Action::Query),
                ),
            )
    }

    pub fn get_metrics_webscope() -> Scope {
        web::scope("/metrics").service(
            web::resource("").route(web::get().to(metrics::get).authorize(Action::Metrics)),
        )
    }

    pub fn get_alerts_webscope() -> Scope {
        web::scope("/alerts")
            .service(
                web::resource("")
                    .route(web::get().to(alerts::list).authorize(Action::GetAlert))
                    .route(web::post().to(alerts::post).authorize(Action::PutAlert)),
            )
            .service(
                web::resource("/list_tags").route(
                    web::get()
                        .to(alerts::list_tags)
                        .authorize(Action::ListDashboard),
                ),
            )
            .service(
                web::resource("/{alert_id}")
                    .route(web::get().to(alerts::get).authorize(Action::GetAlert))
                    .route(
                        web::put()
                            .to(alerts::modify_alert)
                            .authorize(Action::PutAlert),
                    )
                    .route(
                        web::delete()
                            .to(alerts::delete)
                            .authorize(Action::DeleteAlert),
                    ),
            )
            .service(
                web::resource("/{alert_id}/disable").route(
                    web::patch()
                        .to(alerts::disable_alert)
                        .authorize(Action::PutAlert),
                ),
            )
            .service(
                web::resource("/{alert_id}/enable").route(
                    web::patch()
                        .to(alerts::enable_alert)
                        .authorize(Action::PutAlert),
                ),
            )
            .service(
                web::resource("/{alert_id}/update_notification_state").route(
                    web::patch()
                        .to(alerts::update_notification_state)
                        .authorize(Action::PutAlert),
                ),
            )
            .service(
                web::resource("/{alert_id}/evaluate_alert").route(
                    web::put()
                        .to(alerts::evaluate_alert)
                        .authorize(Action::PutAlert),
                ),
            )
    }

    pub fn get_alert_target_policy() -> Scope {
        web::scope("/alert-target-policy").service(
            web::resource("")
                .route(
                    web::get()
                        .to(alert_target_policy::get)
                        .authorize(Action::All),
                )
                .route(
                    web::put()
                        .to(alert_target_policy::put)
                        .authorize(Action::All),
                ),
        )
    }

    pub fn get_targets_webscope() -> Scope {
        web::scope("/targets")
            .service(
                web::resource("")
                    .route(web::get().to(targets::list).authorize(Action::GetAlert))
                    .route(web::post().to(targets::post).authorize(Action::PutAlert)),
            )
            .service(
                web::resource("/{target_id}")
                    .route(web::get().to(targets::get).authorize(Action::GetAlert))
                    .route(web::put().to(targets::update).authorize(Action::PutAlert))
                    .route(
                        web::delete()
                            .to(targets::delete)
                            .authorize(Action::DeleteAlert),
                    ),
            )
    }

    // get the dashboards web scope
    pub fn get_dashboards_webscope() -> Scope {
        web::scope("/dashboards")
            .service(
                web::resource("")
                    .route(
                        web::post()
                            .to(dashboards::create_dashboard)
                            .authorize(Action::CreateDashboard),
                    )
                    .route(
                        web::get()
                            .to(dashboards::list_dashboards)
                            .authorize(Action::ListDashboard),
                    ),
            )
            .service(
                web::resource("/list_tags").route(
                    web::get()
                        .to(dashboards::list_tags)
                        .authorize(Action::ListDashboard),
                ),
            )
            .service(
                web::scope("/{dashboard_id}")
                    .service(
                        web::resource("")
                            .route(
                                web::get()
                                    .to(dashboards::get_dashboard)
                                    .authorize(Action::GetDashboard),
                            )
                            .route(
                                web::delete()
                                    .to(dashboards::delete_dashboard)
                                    .authorize(Action::DeleteDashboard),
                            )
                            .route(
                                web::put()
                                    .to(dashboards::update_dashboard)
                                    .authorize(Action::CreateDashboard),
                            ),
                    )
                    .service(
                        web::resource("/add_tile").route(
                            web::put()
                                .to(dashboards::add_tile)
                                .authorize(Action::CreateDashboard),
                        ),
                    ),
            )
    }

    // get the filters web scope
    pub fn get_filters_webscope() -> Scope {
        web::scope("/filters")
            .service(
                web::resource("")
                    .route(
                        web::post()
                            .to(filters::post)
                            .authorize(Action::CreateFilter),
                    )
                    .route(web::get().to(filters::list).authorize(Action::ListFilter)),
            )
            .service(
                web::resource("/{filter_id}")
                    .route(web::get().to(filters::get).authorize(Action::GetFilter))
                    .route(
                        web::delete()
                            .to(filters::delete)
                            .authorize(Action::DeleteFilter),
                    )
                    .route(
                        web::put()
                            .to(filters::update)
                            .authorize(Action::CreateFilter),
                    ),
            )
    }
    pub fn get_counts_webscope() -> Resource {
        web::resource("/counts").route(web::post().to(query::get_counts).authorize(Action::Query))
    }

    // get the query factory
    // POST "/query" ==> Get results of the SQL query passed in request body
    pub fn get_query_factory() -> Resource {
        web::resource("/query").route(
            web::post()
                .to(query::query)
                .authorize(Action::Query)
                .wrap(IntraClusterRequest),
        )
    }

    // POST "/query/context" ==> Get a page of logs around a selected log line
    pub fn get_query_context_factory() -> Resource {
        web::resource("/query/context").route(
            web::post()
                .to(query_context::query_context)
                .authorize(Action::Query)
                .wrap(IntraClusterRequest),
        )
    }

    // get the logstream web scope
    pub fn get_logstream_webscope() -> Scope {
        web::scope("/logstream")
            .service(
                // GET "/logstream" ==> Get list of all Log Streams on the server
                web::resource("")
                    .route(web::get().to(logstream::list).authorize(Action::ListStream)),
            )
            .service(
                web::scope("/schema/detect").service(
                    web::resource("")
                        // PUT "/logstream/{logstream}" ==> Create log stream
                        .route(
                            web::post()
                                .to(logstream::detect_schema)
                                .authorize(Action::DetectSchema),
                        ),
                ),
            )
            .service(
                web::scope("/{logstream}")
                    .service(
                        web::resource("")
                            // PUT "/logstream/{logstream}" ==> Create log stream
                            .route(
                                web::put()
                                    .to(logstream::put_stream)
                                    .authorize_for_resource(Action::CreateStream),
                            )
                            // POST "/logstream/{logstream}" ==> Post logs to given log stream
                            .route(
                                web::post()
                                    .to(ingest::post_event)
                                    .authorize_for_resource(Action::Ingest)
                                    .wrap(from_fn(
                                        resource_check::check_resource_utilization_middleware,
                                    )),
                            )
                            // DELETE "/logstream/{logstream}" ==> Delete log stream
                            .route(
                                web::delete()
                                    .to(logstream::delete)
                                    .authorize_for_resource(Action::DeleteStream),
                            )
                            .app_data(web::JsonConfig::default().limit(max_event_payload_size())),
                    )
                    .service(
                        // GET "/logstream/{logstream}/info" ==> Get info for given log stream
                        web::resource("/info").route(
                            web::get()
                                .to(logstream::get_stream_info)
                                .authorize_for_resource(Action::GetStreamInfo),
                        ),
                    )
                    .service(
                        // GET "/logstream/{logstream}/schema" ==> Get schema for given log stream
                        web::resource("/schema").route(
                            web::get()
                                .to(logstream::get_schema)
                                .authorize_for_resource(Action::GetSchema),
                        ),
                    )
                    .service(
                        // GET "/logstream/{logstream}/stats" ==> Get stats for given log stream
                        web::resource("/stats").route(
                            web::get()
                                .to(logstream::get_stats)
                                .authorize_for_resource(Action::GetStats),
                        ),
                    )
                    .service(
                        web::resource("/retention")
                            // PUT "/logstream/{logstream}/retention" ==> Set retention for given logstream
                            .route(
                                web::put()
                                    .to(logstream::put_retention)
                                    .authorize_for_resource(Action::PutRetention),
                            )
                            // GET "/logstream/{logstream}/retention" ==> Get retention for given logstream
                            .route(
                                web::get()
                                    .to(logstream::get_retention)
                                    .authorize_for_resource(Action::GetRetention),
                            ),
                    )
                    .service(
                        web::resource("/hottier")
                            // PUT "/logstream/{logstream}/hottier" ==> Set hottier for given logstream
                            .route(
                                web::put()
                                    .to(logstream::put_stream_hot_tier)
                                    .authorize_for_resource(Action::PutHotTierEnabled),
                            )
                            .route(
                                web::get()
                                    .to(logstream::get_stream_hot_tier)
                                    .authorize_for_resource(Action::GetHotTierEnabled)
                                    .wrap(IntraClusterRequest),
                            )
                            .route(
                                web::delete()
                                    .to(logstream::delete_stream_hot_tier)
                                    .authorize_for_resource(Action::DeleteHotTierEnabled),
                            ),
                    ),
            )
    }

    // get the factory for the ingest route
    pub fn get_ingest_factory() -> Resource {
        web::resource("/ingest")
            .route(
                web::post()
                    .to(ingest::ingest)
                    .authorize_for_resource(Action::Ingest),
            )
            .app_data(web::JsonConfig::default().limit(max_event_payload_size()))
    }

    // /v1/logs endpoint to be used for OTEL log ingestion only
    pub fn get_ingest_otel_factory() -> Scope {
        web::scope("/v1")
            .service(
                web::resource("/logs")
                    .route(
                        web::post()
                            .to(ingest::handle_otel_logs_ingestion)
                            .authorize_for_resource(Action::Ingest),
                    )
                    .app_data(web::PayloadConfig::default().limit(max_event_payload_size())),
            )
            .service(
                web::resource("/metrics")
                    .route(
                        web::post()
                            .to(ingest::handle_otel_metrics_ingestion)
                            .authorize_for_resource(Action::Ingest),
                    )
                    .app_data(web::PayloadConfig::default().limit(max_event_payload_size())),
            )
            .service(
                web::resource("/traces")
                    .route(
                        web::post()
                            .to(ingest::handle_otel_traces_ingestion)
                            .authorize_for_resource(Action::Ingest),
                    )
                    .app_data(web::PayloadConfig::default().limit(max_event_payload_size())),
            )
    }

    // get the oauth webscope
    pub fn get_oauth_webscope() -> Scope {
        web::scope("/o")
            .service(resource("/login").route(web::get().to(oidc::login)))
            .service(resource("/logout").route(web::get().to(oidc::logout)))
            .service(resource("/code").route(web::get().to(oidc::reply_login)))
    }
    // get list of roles
    pub fn get_roles_webscope() -> Scope {
        web::scope("/roles")
            .service(web::resource("").route(web::get().to(role::list).authorize(Action::ListRole)))
    }
    // get the role webscope
    pub fn get_user_role_webscope() -> Scope {
        web::scope("/role")
            .service(
                // PUT and GET Default Role
                resource("/default")
                    .route(web::put().to(role::put_default).authorize(Action::PutRole))
                    .route(
                        web::delete()
                            .to(role::delete_default)
                            .authorize(Action::PutRole),
                    )
                    .route(web::get().to(role::get_default).authorize(Action::GetRole)),
            )
            .service(
                // PUT, GET, DELETE Roles
                resource("/{name}")
                    .route(web::put().to(role::put).authorize(Action::PutRole))
                    .route(web::delete().to(role::delete).authorize(Action::DeleteRole))
                    .route(web::get().to(role::get).authorize(Action::GetRole)),
            )
    }

    // get the users webscope (for Prism only)
    pub fn get_users_webscope() -> Scope {
        web::scope("/users")
            .service(
                web::resource("")
                    // GET /users => List all users
                    .route(
                        web::get()
                            .to(http::rbac::list_users_prism)
                            .authorize(Action::ListUser),
                    ),
            )
            .service(
                web::resource("/{userid}").route(
                    web::get()
                        .to(http::rbac::get_prism_user)
                        .authorize_for_user(Action::GetUserRoles),
                ),
            )
    }

    // get the user webscope
    pub fn get_user_webscope() -> Scope {
        web::scope("/user")
            .service(
                web::resource("")
                    // GET /user => List all users
                    .route(
                        web::get()
                            .to(http::rbac::list_users)
                            .authorize(Action::ListUser),
                    ),
            )
            .service(
                web::resource("/{userid}")
                    // POST /user/{userid} => Create a new user
                    .route(
                        web::post()
                            .to(http::rbac::post_user)
                            .authorize(Action::PutUser),
                    )
                    // DELETE /user/{userid} => Delete a user
                    .route(
                        web::delete()
                            .to(http::rbac::delete_user)
                            .authorize(Action::DeleteUser),
                    )
                    .route(
                        web::patch()
                            .to(http::rbac::patch_user)
                            .authorize_for_user(Action::PatchUser),
                    )
                    .wrap(DisAllowRootUser),
            )
            .service(
                web::resource("/{userid}/role").route(
                    web::get()
                        .to(http::rbac::get_role)
                        .authorize_for_user(Action::GetUserRoles),
                ),
            )
            .service(
                web::resource("/{userid}/role/add")
                    // PATCH /user/{userid}/role/add => Add roles to a user
                    .route(
                        web::patch()
                            .to(http::rbac::add_roles_to_user)
                            .authorize(Action::PutUserRoles)
                            .wrap(DisAllowRootUser),
                    ),
            )
            .service(
                web::resource("/{userid}/role/remove")
                    // PATCH /user/{userid}/role/remove => Remove roles from a user
                    .route(
                        web::patch()
                            .to(http::rbac::remove_roles_from_user)
                            .authorize(Action::PutUserRoles)
                            .wrap(DisAllowRootUser),
                    ),
            )
            .service(
                web::resource("/{userid}/generate-new-password")
                    // POST /user/{userid}/generate-new-password => reset password for this user
                    .route(
                        web::post()
                            .to(http::rbac::post_gen_password)
                            .authorize(Action::PutUser)
                            .wrap(DisAllowRootUser),
                    ),
            )
    }

    // get the live check
    // GET "/liveness" ==> Liveness check as per https://kubernetes.io/docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes/#define-a-liveness-command
    // HEAD "/liveness"
    pub fn get_liveness_factory() -> Resource {
        web::resource("/liveness")
            .route(web::get().to(health_check::liveness))
            .route(web::head().to(health_check::liveness))
    }

    // get the readiness check
    // GET "/readiness" ==> Readiness check as per https://kubernetes.io/docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes/#define-readiness-probes
    // HEAD "/readiness"
    pub fn get_readiness_factory() -> Resource {
        web::resource("/readiness")
            .route(web::get().to(health_check::readiness))
            .route(web::head().to(health_check::readiness))
    }

    // get the about factory
    pub fn get_about_factory() -> Resource {
        web::resource("/about").route(web::get().to(about::about).authorize(Action::GetAbout))
    }

    // get the dataset stats webscope
    pub fn get_dataset_stats_webscope() -> Resource {
        web::resource("/dataset_stats")
            .route(web::post().to(get_dataset_stats).authorize(Action::Query))
    }

    // GET "/" ==> Serve the UI chosen by P_UI_ROOT
    // GET "/next" ==> Serve the native frontend beside the classic UI, or redirect to "/"
    pub fn configure_ui(config: &mut web::ServiceConfig) {
        Self::mount_ui(
            config,
            generate(),
            generate_next(),
            PARSEABLE.options.ui_root,
        );
    }

    /// The native frontend serves `/` unless `root` is classic or no native build
    /// was embedded; the classic UI then serves `/` and the native one, if any,
    /// `/next`. `/next` is registered ahead of the catch-all `/` either way.
    fn mount_ui(config: &mut web::ServiceConfig, classic: UiFiles, native: UiFiles, root: UiRoot) {
        if native.is_empty() {
            if root == UiRoot::Native {
                static WARNED: Once = Once::new();
                WARNED.call_once(|| {
                    tracing::warn!("P_UI_ROOT=native, but no native frontend was embedded; serving the classic UI")
                });
            }
            config.service(Self::ui_scope("", classic));
        } else if root == UiRoot::Native {
            config.service(web::scope("/next").default_service(web::to(redirect_from_next)));
            config.service(Self::ui_scope("", native));
        } else {
            config.service(Self::ui_scope("/next", native));
            config.service(Self::ui_scope("", classic));
        }
    }

    fn ui_scope(
        path: &str,
        files: UiFiles,
    ) -> Scope<
        impl ServiceFactory<
            ServiceRequest,
            Config = (),
            Response = ServiceResponse<impl MessageBody>,
            Error = actix_web::Error,
            InitError = (),
        >,
    > {
        web::scope(path)
            .wrap(from_fn(ui_cache_control))
            .service(ResourceFiles::new("", UiBuild::new(files, path)))
    }
}

type UiFiles = std::collections::HashMap<&'static str, static_files::Resource>;

/// A UI build served as a single-page app: any path that is not a file is a
/// client-side route and gets `index.html`.
struct UiBuild(UiFiles);

impl UiBuild {
    /// The native build loads its assets relative to `<base href="/">`. Pointing
    /// that at the mount lets one build serve `/` and `/next`.
    fn new(mut files: UiFiles, mount: &str) -> Self {
        if !mount.is_empty()
            && let Some(index) = files.get_mut("index.html")
        {
            index.data = mounted_index(index.data, mount);
        }
        Self(files)
    }
}

/// `index` with its base at `mount`, built once per build and mount since every
/// worker mounts the UI and the served bytes must be `'static`.
fn mounted_index(index: &'static [u8], mount: &str) -> &'static [u8] {
    type Key = (usize, String);
    static MOUNTED: LazyLock<Mutex<HashMap<Key, &'static [u8]>>> = LazyLock::new(Default::default);
    MOUNTED
        .lock()
        .unwrap()
        .entry((index.as_ptr() as usize, mount.to_owned()))
        .or_insert_with(|| {
            let html = String::from_utf8_lossy(index).replacen(
                r#"<base href="/""#,
                &format!(r#"<base href="{mount}/""#),
                1,
            );
            Box::leak(html.into_bytes().into_boxed_slice())
        })
}

/// The native frontend moved from `/next` to `/`. Old links, bookmarks and
/// logins started there keep their path and query. The redirect is temporary so
/// browsers do not keep it while `P_UI_ROOT=classic` can move the UI back.
async fn redirect_from_next(req: HttpRequest) -> HttpResponse {
    let rest = req.path().strip_prefix("/next").unwrap_or_default();
    // A leading `//` or `/\` would leave the origin.
    let path = format!("/{}", rest.trim_start_matches(['/', '\\']));
    let location = match req.query_string() {
        "" => path,
        query => format!("{path}?{query}"),
    };
    HttpResponse::TemporaryRedirect()
        .insert_header((LOCATION, location))
        .insert_header((CACHE_CONTROL, "no-store"))
        .finish()
}

impl ResourceFilesCollection for UiBuild {
    type Resource = static_files::Resource;

    /// A missing hashed asset stays a 404. A tab opened before a deploy asks for
    /// chunks the new build no longer has, and HTML in their place fails to load
    /// as a script without the browser ever seeing an error status.
    fn get_resource(&self, path: &str) -> Option<&Self::Resource> {
        let path = path.trim_start_matches('/');
        self.0
            .get(path)
            .or_else(|| (!is_hashed_asset(path)).then(|| self.0.get("index.html"))?)
    }

    fn contains_key(&self, path: &str) -> bool {
        self.0.contains_key(path)
    }
}

/// Vite names every file it emits under `assets/` after a hash of its content,
/// in both UIs. Only the prefix is checked: client routes such as Prism's
/// `/apm/<service>` may end in a segment containing a dot.
fn is_hashed_asset(path: &str) -> bool {
    path.trim_start_matches('/').starts_with("assets/")
}

/// Hashed assets never change, so browsers may keep them for good. Everything
/// else, `index.html` above all, is revalidated on each use so a deploy is
/// picked up by the next navigation.
async fn ui_cache_control(
    req: ServiceRequest,
    next: Next<impl MessageBody>,
) -> Result<ServiceResponse<impl MessageBody>, actix_web::Error> {
    let hashed = is_hashed_asset(req.match_info().unprocessed());
    let mut response = next.call(req).await?;
    let status = response.status();
    let value = if hashed && (status.is_success() || status == StatusCode::NOT_MODIFIED) {
        "public, max-age=31536000, immutable"
    } else {
        "no-cache"
    };
    response
        .headers_mut()
        .insert(CACHE_CONTROL, HeaderValue::from_static(value));
    Ok(response)
}

#[cfg(test)]
mod tests {
    use actix_web::{App, body::to_bytes, dev::ServiceResponse, test};

    use super::*;

    fn file(data: &'static [u8], mime_type: &'static str) -> static_files::Resource {
        static_files::Resource {
            data,
            modified: 0,
            mime_type,
        }
    }

    fn ui(index: &'static [u8]) -> UiFiles {
        UiFiles::from([
            ("index.html", file(index, "text/html")),
            ("assets/index-abc123.js", file(b"chunk", "text/javascript")),
            ("favicon.ico", file(b"icon", "image/x-icon")),
        ])
    }

    async fn serve(path: &str, native: UiFiles, root: UiRoot) -> ServiceResponse {
        let app = test::init_service(
            App::new().configure(|config| Server::mount_ui(config, ui(b"classic"), native, root)),
        )
        .await;
        test::call_service(&app, test::TestRequest::get().uri(path).to_request()).await
    }

    /// With the classic UI at `/` and the native one beside it under `/next`.
    async fn get(path: &str, next: UiFiles) -> ServiceResponse {
        serve(path, next, UiRoot::Classic).await
    }

    async fn body_from(path: &str, native: UiFiles, root: UiRoot) -> Bytes {
        let response = serve(path, native, root).await;
        assert!(response.status().is_success(), "GET {path} failed");
        to_bytes(response.into_body()).await.unwrap()
    }

    async fn body_at(path: &str, next: UiFiles) -> Bytes {
        body_from(path, next, UiRoot::Classic).await
    }

    fn location(response: &ServiceResponse) -> &str {
        response.headers().get(LOCATION).unwrap().to_str().unwrap()
    }

    fn cache_control(response: &ServiceResponse) -> &str {
        response
            .headers()
            .get(CACHE_CONTROL)
            .unwrap()
            .to_str()
            .unwrap()
    }

    #[actix_web::test]
    async fn next_routes_take_precedence_over_the_root_fallback() {
        for path in [
            "/next",
            "/next/",
            "/next/logs?x=1",
            "/next/oidc-not-configured",
        ] {
            assert_eq!(body_at(path, ui(b"next")).await, "next", "GET {path}");
        }
        for path in ["/", "/logs", "/nextfoo", "/oidc-not-configured"] {
            assert_eq!(body_at(path, ui(b"next")).await, "classic", "GET {path}");
        }
    }

    #[actix_web::test]
    async fn without_a_next_build_the_classic_ui_serves_next_paths() {
        assert_eq!(body_at("/next/logs", UiFiles::new()).await, "classic");
    }

    #[actix_web::test]
    async fn client_routes_get_index_html_even_with_a_dot_in_them() {
        for path in [
            "/apm/checkout.api",
            "/errors/TypeError.x",
            "/assetsfoo/a.js",
        ] {
            assert_eq!(body_at(path, UiFiles::new()).await, "classic", "GET {path}");
        }
        assert_eq!(body_at("/next/apm/a.b", ui(b"next")).await, "next");
    }

    #[actix_web::test]
    async fn a_missing_hashed_asset_is_not_found() {
        for path in ["/assets/index-gone.js", "/next/assets/index-gone.js"] {
            let response = get(path, ui(b"next")).await;
            assert_eq!(response.status(), StatusCode::NOT_FOUND, "GET {path}");
            assert_eq!(cache_control(&response), "no-cache", "GET {path}");
        }
    }

    #[actix_web::test]
    async fn hashed_assets_are_immutable_and_everything_else_revalidates() {
        for path in ["/assets/index-abc123.js", "/next/assets/index-abc123.js"] {
            let response = get(path, ui(b"next")).await;
            assert_eq!(response.status(), StatusCode::OK, "GET {path}");
            assert_eq!(
                cache_control(&response),
                "public, max-age=31536000, immutable",
                "GET {path}"
            );
        }
        for path in ["/", "/logs", "/favicon.ico", "/next", "/next/team"] {
            let response = get(path, ui(b"next")).await;
            assert_eq!(response.status(), StatusCode::OK, "GET {path}");
            assert_eq!(cache_control(&response), "no-cache", "GET {path}");
        }
    }

    #[actix_web::test]
    async fn existing_files_are_served_as_themselves() {
        assert_eq!(
            body_at("/assets/index-abc123.js", UiFiles::new()).await,
            "chunk"
        );
        assert_eq!(body_at("/favicon.ico", UiFiles::new()).await, "icon");
        assert_eq!(body_at("/next/favicon.ico", ui(b"next")).await, "icon");
    }

    #[actix_web::test]
    async fn the_native_frontend_serves_the_root_by_default() {
        assert_eq!(UiRoot::default(), UiRoot::Native);
        for path in ["/", "/logs/explore/app", "/nextfoo", "/oidc-not-configured"] {
            assert_eq!(
                body_from(path, ui(b"native"), UiRoot::Native).await,
                "native",
                "GET {path}"
            );
        }
    }

    #[actix_web::test]
    async fn next_links_redirect_to_the_same_page_at_the_root() {
        for (path, target) in [
            ("/next", "/"),
            ("/next/", "/"),
            (
                "/next/logs/explore/app?start=1h&end=now",
                "/logs/explore/app?start=1h&end=now",
            ),
            ("/next/oidc-not-configured", "/oidc-not-configured"),
            ("/next//evil.example/x", "/evil.example/x"),
            ("/next/\\evil.example", "/evil.example"),
            ("/next/\\/evil.example", "/evil.example"),
            ("/next/%5Cevil.example", "/%5Cevil.example"),
        ] {
            let response = serve(path, ui(b"native"), UiRoot::Native).await;
            assert_eq!(
                response.status(),
                StatusCode::TEMPORARY_REDIRECT,
                "GET {path}"
            );
            assert_eq!(location(&response), target, "GET {path}");
        }
    }

    #[actix_web::test]
    async fn without_a_native_build_the_classic_ui_serves_the_root() {
        for root in [UiRoot::Native, UiRoot::Classic] {
            assert_eq!(body_from("/logs", UiFiles::new(), root).await, "classic");
            assert_eq!(
                body_from("/next/logs", UiFiles::new(), root).await,
                "classic"
            );
        }
    }

    #[actix_web::test]
    async fn the_native_build_loads_its_assets_from_its_mount() {
        let native = || ui(br#"<head><base href="/" /></head>"#);
        assert_eq!(
            body_from("/next/logs", native(), UiRoot::Classic).await,
            r#"<head><base href="/next/" /></head>"#
        );
        assert_eq!(
            body_from("/logs", native(), UiRoot::Native).await,
            r#"<head><base href="/" /></head>"#
        );
        let asset = serve("/next/assets/index-abc123.js", native(), UiRoot::Classic).await;
        assert_eq!(to_bytes(asset.into_body()).await.unwrap(), "chunk");
    }
}
