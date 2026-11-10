#![allow(deprecated)]
use futures::TryStreamExt;
use object_store::{ObjectStore, ObjectStoreExt, aws::AmazonS3Builder, path::Path};
use parquet::{
    DecodeResult,
    file::metadata::{PageIndexPolicy, ParquetMetaDataPushDecoder},
};
use std::sync::Arc;
#[tokio::main]
async fn main() {
    let endpoint = std::env::args().nth(1).unwrap();
    let store: Arc<dyn ObjectStore> = Arc::new(
        AmazonS3Builder::new()
            .with_bucket_name("bench")
            .with_region("us-east-1")
            .with_access_key_id("local")
            .with_secret_access_key("local")
            .with_endpoint(endpoint)
            .with_allow_http(true)
            .with_retry(object_store::RetryConfig {
                max_retries: 5,
                ..Default::default()
            })
            .build()
            .unwrap(),
    );
    for name in ["small", "large", "xlarge"] {
        let mut baseline = None;
        for hint in [65536, 524288, 2097152] {
            let path = Path::from(format!("{name}-{hint}.parquet"));
            let meta = store.head(&path).await.unwrap();
            let start = std::time::Instant::now();
            // Mirror DFParquetMetadata::fetch_metadata_from_store in DataFusion 55.
            // Run the production decoder rather than estimating requests from footer sizes.
            let mut decoder = ParquetMetaDataPushDecoder::try_new(meta.size)
                .unwrap()
                .with_page_index_policy(PageIndexPolicy::Optional);
            let prefetch = meta.size.saturating_sub(hint as u64)..meta.size;
            let buffers = store
                .get_ranges(&path, std::slice::from_ref(&prefetch))
                .await
                .unwrap();
            decoder.push_ranges(vec![prefetch], buffers).unwrap();
            let metadata = Arc::new(loop {
                match decoder.try_decode().unwrap() {
                    DecodeResult::Data(metadata) => break metadata,
                    DecodeResult::NeedsData(ranges) => {
                        let buffers = store.get_ranges(&path, &ranges).await.unwrap();
                        decoder.push_ranges(ranges, buffers).unwrap();
                    }
                    DecodeResult::Finished => panic!("metadata decoder finished without metadata"),
                }
            });
            let cold = start.elapsed().as_micros();
            assert!(metadata.column_index().is_some() && metadata.offset_index().is_some());
            let decoded = format!("{metadata:?}");
            if let Some(expected) = &baseline {
                assert_eq!(expected, &decoded, "metadata differs across hints");
            } else {
                baseline = Some(decoded);
            }

            // Explicit immutable-metadata reuse control; this is not a DataFusion cache hit measurement.
            let warm = Arc::clone(&metadata);
            println!(
                "{}",
                serde_json::json!({"metadata_equal_across_hints":true,"case":name,"hint":hint,"object_bytes":meta.size,"row_groups":warm.num_row_groups(),"cold_metadata_us":cold,"page_index_policy":"Optional","column_index_loaded":warm.column_index().is_some(),"offset_index_loaded":warm.offset_index().is_some(),"warm_control":"Arc metadata reuse, zero I/O"})
            );
        }
    }
    let ranges = [0..1024, 4096..5120, 2097152..2098176];
    let chunks = store
        .get_ranges(&Path::from("ranges.parquet"), &ranges)
        .await
        .unwrap();
    assert_eq!(chunks.iter().map(|b| b.len()).sum::<usize>(), 3072);
    store
        .get_range(&Path::from("retry.parquet"), 0..1024)
        .await
        .unwrap();
    store
        .put(&Path::from("upload.parquet"), vec![42u8; 4096].into())
        .await
        .unwrap();
    assert_eq!(
        store
            .head(&Path::from("upload.parquet"))
            .await
            .unwrap()
            .size,
        4096
    );
    let listed: Vec<_> = store.list(None).try_collect().await.unwrap();
    assert!(!listed.is_empty());
}
