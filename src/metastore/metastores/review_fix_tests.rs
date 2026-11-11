//! Isolated PostgreSQL review regressions.
#[cfg(test)]
mod tests {
    //! Isolated regression tests; each database is disposable and unique.
    use super::super::{
        postgres_documents::PostgresDocuments,
        postgres_metastore::{PostgresMetastore, PostgresOptions},
    };
    use crate::{
        metastore::metastore_traits::Metastore,
        storage::{LocalFS, ObjectStorage},
    };
    use bytes::Bytes;
    use relative_path::RelativePath;
    use std::sync::Arc;

    #[test]
    fn empty_url_is_disabled() {
        for url in [None, Some("".into()), Some("  ".into())] {
            assert!(
                !PostgresOptions {
                    metastore_postgres_url: url,
                    ..Default::default()
                }
                .enabled()
            );
        }
    }
    #[test]
    fn ca_replaces_public_roots() -> anyhow::Result<()> {
        let dir = tempfile::tempdir_in(concat!(env!("CARGO_MANIFEST_DIR"), "/target"))?;
        let ca = dir.path().join("ca.pem");
        let key = dir.path().join("key.pem");
        let output = std::process::Command::new("openssl")
            .args([
                "req",
                "-x509",
                "-newkey",
                "rsa:2048",
                "-nodes",
                "-days",
                "1",
                "-subj",
                "/CN=review",
            ])
            .arg("-keyout")
            .arg(key)
            .arg("-out")
            .arg(&ca)
            .output()?;
        assert!(output.status.success());
        assert_eq!(
            super::super::postgres_documents::configured_roots(Some(&ca))?.len(),
            1
        );
        assert!(super::super::postgres_documents::configured_roots(None)?.len() > 1);
        Ok(())
    }
    #[test]
    fn unavailable_and_deleting_http_status() {
        use crate::storage::ObjectStorageError;
        use actix_web::{ResponseError, http::StatusCode};
        for (error, status) in [
            (ObjectStorageError::StreamDeleting, StatusCode::CONFLICT),
            (
                ObjectStorageError::MetastoreUnavailable("outage".into()),
                StatusCode::SERVICE_UNAVAILABLE,
            ),
        ] {
            let stream: crate::handlers::http::logstream::error::StreamError = error.into();
            assert_eq!(stream.status_code(), status);
            let source = if status == StatusCode::CONFLICT {
                ObjectStorageError::StreamDeleting
            } else {
                ObjectStorageError::MetastoreUnavailable("outage".into())
            };
            let detail = crate::metastore::MetastoreError::from(source).to_detail();
            let nested = crate::handlers::http::ingest::PostError::CreateStream(
                crate::handlers::http::logstream::error::CreateStreamError::Storage {
                    stream_name: "review".into(),
                    err: ObjectStorageError::MetastoreError(Box::new(detail)),
                },
            );
            assert_eq!(nested.status_code(), status);
        }
    }
    #[test]
    fn parsed_url_controls_tuning_validation() {
        use clap::Parser;
        #[derive(Parser)]
        struct Args {
            #[command(flatten)]
            postgres: PostgresOptions,
        }
        for url in ["", "  "] {
            let opts = Args::try_parse_from([
                "review",
                "--metastore-postgres-url",
                url,
                "--metastore-postgres-pool-size",
                "bad",
                "--metastore-postgres-statement-timeout-ms",
                "bad",
            ])
            .unwrap();
            assert!(!opts.postgres.enabled());
            assert_eq!(opts.postgres.metastore_postgres_statement_timeout_ms, 10000);
        }
        for (flag, value) in [
            ("--metastore-postgres-pool-size", "0"),
            ("--metastore-postgres-connect-timeout-ms", "bad"),
            ("--metastore-postgres-statement-timeout-ms", "0"),
        ] {
            assert!(
                Args::try_parse_from([
                    "review",
                    "--metastore-postgres-url",
                    "postgresql://example/test",
                    flag,
                    value
                ])
                .is_err()
            );
        }
        let mut opts = Args::try_parse_from([
            "review",
            "--metastore-postgres-url",
            "postgresql://example/test",
            "--metastore-postgres-pool-size",
            "2",
            "--metastore-postgres-statement-timeout-ms",
            "321",
        ])
        .unwrap();
        assert_eq!(opts.postgres.metastore_postgres_pool_size, 2);
        assert_eq!(opts.postgres.metastore_postgres_statement_timeout_ms, 321);
        opts.try_update_from(["review", "--metastore-postgres-pool-size", "3"])
            .unwrap();
        assert!(opts.postgres.enabled());
        assert_eq!(opts.postgres.metastore_postgres_pool_size, 3);
    }
    fn initialize_context() {
        fn factory() -> crate::parseable::Parseable {
            use crate::storage::object_storage::ObjectStorageProvider;
            let root = tempfile::tempdir_in(concat!(env!("CARGO_MANIFEST_DIR"), "/target"))
                .unwrap()
                .keep();
            let provider = Arc::new(crate::storage::FSConfig { root });
            let storage = provider.construct_client();
            let metastore = Arc::new(super::super::object_store_metastore::ObjectStoreMetastore {
                storage: storage.clone(),
            });
            let context = crate::parseable::Parseable::new(
                crate::cli::Options::default(),
                #[cfg(feature = "kafka")]
                <crate::connectors::kafka::config::KafkaConfig as clap::Parser>::parse_from([
                    "contract",
                ]),
                provider,
                metastore,
                storage,
            );
            *context.tenants.write().unwrap() = vec![String::new(), "tenant-contract".into()];
            context
        }
        let _ = crate::parseable::CONTRACT_PARSEABLE_FACTORY.set(factory);
        once_cell::sync::Lazy::force(&crate::parseable::PARSEABLE);
    }

    #[tokio::test]
    async fn review_regressions() -> anyhow::Result<()> {
        let Ok(url) = std::env::var("P_TEST_POSTGRES_URL") else {
            eprintln!("SKIP review_regressions: P_TEST_POSTGRES_URL unset");
            return Ok(());
        };
        let dir = tempfile::tempdir_in(concat!(env!("CARGO_MANIFEST_DIR"), "/target"))?;
        let storage: Arc<dyn ObjectStorage> = Arc::new(LocalFS::new(dir.path().to_owned()));
        let opts = PostgresOptions {
            metastore_postgres_url: Some(url.clone()),
            metastore_postgres_pool_size: 2,
            metastore_postgres_statement_timeout_ms: 2000,
            ..Default::default()
        };
        let admin_options = PostgresOptions {
            metastore_postgres_statement_timeout_ms: 10000,
            ..opts.clone()
        };
        let admin = PostgresDocuments::new(&admin_options, "admin".into(), storage.clone())?;
        let name = format!("review_{}", uuid::Uuid::new_v4().simple());
        admin
            .client()
            .await?
            .batch_execute(&format!("CREATE DATABASE {name}"))
            .await?;
        initialize_context();
        let result = async {
        let mut url = url::Url::parse(&url)?;
        url.set_path(&format!("/{name}"));
        url.query_pairs_mut().append_pair("options","-c application_name=review-preserved");
        let query = url.query().unwrap().replace('+',"%20");
        url.set_query(Some(&query));
        let opts = PostgresOptions {
            metastore_postgres_url: Some(url.to_string()),
            ..opts
        };
        let db = Arc::new(PostgresDocuments::new(
            &opts,
            "review".into(),
            storage.clone(),
        )?);
        db.check(&None).await?;
        assert_eq!(db.client().await?.query_one("SHOW application_name",&[]).await?.get::<_,String>(0),"review-preserved");
        let store = PostgresMetastore {
            storage: db.clone(),
        };
        for key in ["odd%stream/manifest%25.json", "odd%stream/dir%25/file"] {
            db.put_object(RelativePath::new(key),Bytes::new(),&None).await?;
            assert_eq!(db.absolute_url(RelativePath::new(key)).as_ref(),key);
        }
        let listed = db.list_with_delimiter(Some(object_store::path::Path::parse("odd%stream")?),&None).await?;
        assert!(listed.objects.iter().any(|o|o.location.as_ref()=="odd%stream/manifest%25.json"));
        assert!(listed.common_prefixes.iter().any(|p|p.as_ref()=="odd%stream/dir%25"));
        let time = chrono::Utc::now();
        // Feed the returned locator back through SQL after two overwrites.
        // Path helpers use the process context, initialized by the shared suite.
        let locator = store.get_manifest_path("logs", time, time, &None).await?;
        assert!(!locator.starts_with(dir.path().to_str().unwrap().trim_start_matches('/')));
        for n in [1, 2] {
            let mut manifest = store
                .get_manifest("logs", time, time, Some(locator.clone()), &None)
                .await?
                .unwrap_or_default();
            manifest.files.push(crate::catalog::manifest::File {
                file_path: format!("{n}.parquet"),
                ..Default::default()
            });
            store
                .put_manifest(&manifest, "logs", time, time, &None)
                .await?;
            assert_eq!(
                store
                    .get_manifest("logs", time, time, Some(locator.clone()), &None)
                    .await?
                    .unwrap()
                    .files
                    .len(),
                n
            );
        }
        if let Ok(endpoint) = std::env::var("P_TEST_REVIEW_S3_URL") {
            use clap::Parser;
            use crate::storage::ObjectStorageProvider;
            #[derive(clap::Parser)]
            struct S3Args { #[command(flatten)] storage: crate::storage::S3Config }
            let provider = S3Args::parse_from(["review","--endpoint-url",&endpoint,"--region","us-east-1","--bucket-name","review","--access-key-id","minioadmin","--secret-key","minioadmin"]).storage;
            let s3 = provider.construct_client();
            let cloud = PostgresMetastore {storage:Arc::new(PostgresDocuments::new(&opts,"review".into(),s3)?)};
            let locator = cloud.get_manifest_path("cloud",time,time,&None).await?;
            for n in [1,2] {
                let mut manifest = cloud.get_manifest("cloud",time,time,Some(locator.clone()),&None).await?.unwrap_or_default();
                manifest.files.push(crate::catalog::manifest::File {file_path:format!("{n}.parquet"),..Default::default()});
                cloud.put_manifest(&manifest,"cloud",time,time,&None).await?;
                assert_eq!(cloud.get_manifest("cloud",time,time,Some(locator.clone()),&None).await?.unwrap().files.len(),n);
            }
        } else {eprintln!("SKIP S3 locator regression: P_TEST_REVIEW_S3_URL unset");}
        let key = RelativePath::new("logs/.stream/.stream.json");
        db.put_object(
            key,
            Bytes::from_static(b"{}"),
            &Some("DEFAULT_TENANT".into()),
        )
        .await?;
        assert!(db.stream_exists("logs", &None).await?);
        let other = Some("logs-other".into());
        db.put_object(
            RelativePath::new("logs-other/logs/.stream/.stream.json"),
            Bytes::new(),
            &other,
        )
        .await?;
        db.put_object(
            RelativePath::new("logs-other/exclusive/.stream/.stream.json"),
            Bytes::new(),
            &other,
        )
        .await?;
        assert_eq!(
            db.list_streams(&None).await?,
            std::collections::HashSet::from(["logs".into()])
        );
        assert_eq!(db.list_streams(&other).await?.len(), 2);
        // Concurrent marker/create admission; after the marker every write fails.
        for _ in 0..10 {
            db.delete_object(RelativePath::new("logs/.stream/.deleting"), &None)
                .await?;
            let (marker, _) = tokio::join!(
                db.put_object(
                    RelativePath::new("logs/.stream/.deleting"),
                    Bytes::new(),
                    &None
                ),
                db.put_object(key, Bytes::new(), &None)
            );
            marker?;
            assert!(matches!(
                db.put_object(key, Bytes::new(), &None).await,
                Err(crate::storage::ObjectStorageError::StreamDeleting)
            ));
        }
        db.delete_object(RelativePath::new("logs/.stream/.deleting"), &None).await?;
        let mut held = db.client().await?;
        let tx = held.transaction().await?;
        tx.execute("INSERT INTO parseable_documents(tenant,kind,key,body) VALUES('','document','logs/.stream/.deleting',''::bytea)",&[]).await?;
        let create = db.put_object(key,Bytes::new(),&None);
        tokio::pin!(create);
        assert!(tokio::time::timeout(std::time::Duration::from_millis(50),&mut create).await.is_err());
        tx.commit().await?;
        assert!(matches!(create.await,Err(crate::storage::ObjectStorageError::StreamDeleting)));
        drop(held);
        assert!(db.list_streams(&None).await?.is_empty());
        db.delete_stream("logs", &None).await?;
        db.put_object(key, Bytes::new(), &None).await?;
        // SQL-only leftovers remain discoverable after physical partition deletion.
        let partition = RelativePath::new("logs/date=2020-01-01");
        db.put_object(
            RelativePath::new("logs/date=2020-01-01/node.manifest.json"),
            Bytes::new(),
            &None,
        )
        .await?;
        assert_eq!(
            store.metadata_dates("logs", &None).await?,
            vec![".stream", "date=2020-01-01"]
        );
        storage.put_object(RelativePath::new("logs/date=2020-01-01/data.parquet"),Bytes::new(),&None).await?;
        db.deletion_fault.store(3,std::sync::atomic::Ordering::SeqCst);
        assert!(db.delete_partition(partition,&None).await.is_err());
        assert!(storage.get_object(RelativePath::new("logs/date=2020-01-01/data.parquet"),&None).await.is_err());
        assert!(store.metadata_dates("logs",&None).await?.contains(&"date=2020-01-01".into()));
        db.deletion_fault.store(0,std::sync::atomic::Ordering::SeqCst);
        db.delete_partition(partition, &None).await?;
        assert_eq!(store.metadata_dates("logs", &None).await?, vec![".stream"]);
        let paths: Vec<_> = (0..200)
            .map(|n| format!("batch/{n}.manifest.json"))
            .collect();
        for p in &paths {
            let manifest = crate::catalog::manifest::Manifest {
                files: vec![crate::catalog::manifest::File {file_path:"batch-data.parquet".into(),num_rows:1,..Default::default()}],
                ..Default::default()
            };
            db.put_object(RelativePath::new(p), crate::catalog::manifest::encode_manifest(&manifest)?, &None).await?;
        }
        let decoded = store.manifest_batch(&paths, &None).await?.expect("PostgreSQL batch override");
        assert_eq!(decoded.len(),200);
        assert!(decoded.values().all(|m|m.as_ref().is_some_and(|m|m.files.len()==1 && m.files[0].num_rows==1)));
        assert!(
            db.delete_prefix(RelativePath::new("tenant/stream"), &None)
                .await
                .is_err()
        );
        let client = db.client().await?;
        client.batch_execute("SET default_transaction_read_only=on").await?;
        assert!(client.execute("UPDATE parseable_documents SET kind=kind WHERE false",&[]).await.is_err());
        drop(client);
        db.put_object(RelativePath::new("after-failover"),Bytes::new(),&None).await?;
        // Server timeout and subsequent pool usability.
        assert!(
            db.client()
                .await?
                .query("SELECT pg_sleep(3)", &[])
                .await
                .is_err()
        );
        assert_eq!(
            db.client()
                .await?
                .query_one("SELECT 1", &[])
                .await?
                .get::<_, i32>(0),
            1
        );
        // Drop packets without resetting sockets, including on established sessions.
        use std::sync::atomic::{AtomicBool, Ordering};
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let proxy_port = listener.local_addr()?.port();
        let destination = format!("127.0.0.1:{}", url.port().unwrap());
        let paused = Arc::new(AtomicBool::new(false));
        let gate = paused.clone();
        let proxy = tokio::spawn(async move {
            while let Ok((incoming, _)) = listener.accept().await {
                let Ok(outgoing) = tokio::net::TcpStream::connect(&destination).await else {
                    continue;
                };
                let gate = gate.clone();
                tokio::spawn(async move {
                    let (mut ir, mut iw) = incoming.into_split();
                    let (mut or, mut ow) = outgoing.into_split();
                    let forward = async move {
                        let mut buf = [0; 8192];
                        loop {
                            let n = ir.read(&mut buf).await?;
                            if n == 0 {
                                break;
                            }
                            while gate.load(Ordering::SeqCst) {
                                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
                            }
                            ow.write_all(&buf[..n]).await?;
                        }
                        Ok::<_, std::io::Error>(())
                    };
                    tokio::select! { _ = forward => {}, _ = tokio::io::copy(&mut or,&mut iw) => {} }
                });
            }
        });
        let mut proxy_url = url.clone();
        proxy_url.set_port(Some(proxy_port)).unwrap();
        let proxy_options = PostgresOptions {
            metastore_postgres_url: Some(proxy_url.to_string()),
            metastore_postgres_statement_timeout_ms: 300,
            ..opts.clone()
        };
        let proxied = PostgresDocuments::new(&proxy_options, "review".into(), storage.clone())?;
        proxied.check(&None).await?;
        paused.store(true, Ordering::SeqCst);
        for _ in 0..4 {
            let started = std::time::Instant::now();
            assert!(tokio::time::timeout(std::time::Duration::from_secs(2),proxied.check_health(&None)).await.expect("readiness exceeded client budget").is_err());
            assert!(started.elapsed() < std::time::Duration::from_secs(2));
        }
        paused.store(false, Ordering::SeqCst);
        proxied.check_health(&None).await?;
        proxy.abort();
        // Nonempty SQL cannot establish a fresh bucket pairing on restart.
        storage
            .delete_object(RelativePath::new(super::super::migration::PAIR), &None)
            .await?;
        let restarted = PostgresDocuments::new(&opts, "review".into(), storage.clone())?;
        assert!(
            restarted
                .check(&None)
                .await
                .unwrap_err()
                .to_string()
                .contains("nonempty database")
        );
        Ok::<_, anyhow::Error>(())
    }
    .await;
        admin
            .client()
            .await?
            .batch_execute(&format!("DROP DATABASE {name} WITH (FORCE)"))
            .await?;
        result
    }
}
