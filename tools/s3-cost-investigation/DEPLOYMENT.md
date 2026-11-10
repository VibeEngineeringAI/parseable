# Deployment mechanism audit (2026-11-10)

Repository evidence cannot establish deployed route tables, bucket encryption,
versions, object ages or bills. No AWS credentials or billing exports were used.
The following are conditional mechanisms, not measured dollar savings or applied
infrastructure changes. Sources were checked against primary AWS documentation.

| Mechanism | Verified mechanism and repository evidence | Decision and cost term |
| --- | --- | --- |
| S3 network path | `src/storage/s3.rs` takes explicit endpoint and region; it does not configure VPC routing. Same-region S3 gateway endpoints have no additional charge, unlike interface endpoints. | Check bucket/node region, route tables, endpoint and bucket policies and actual NAT byte usage. Potential saving is avoided NAT GB times rate; retain NAT hourly cost unless the gateway can actually be removed for all uses. No endpoint or routing change here. |
| Paid transfer | Same-region AWS-service/S3 transfer ordinarily has no S3 transfer charge; NAT processing remains separate. | Never multiply all GET bytes by internet egress rates. Cross-region, internet/client result egress and any chargeable network processing need separate path volumes. |
| Encryption | Client exposes SSE-C only. Bucket-default SSE-KMS could still apply; its deployment is unknown. | Bucket Keys are conditional on SSE-KMS, not SSE-C or DSSE-KMS. Savings depend on requesters and access pattern. Bucket ARN replaces object ARN in encryption context, affecting policies and audit semantics; tenant access requirements must be revalidated before any change. No universal 99% assumption. |
| Multipart leftovers | Production upload helper aborts on ordinary errors/cancellation; abrupt process termination can leave parts. Default part threshold is 25 MiB. | Export incomplete-part bytes and age first. Cleanup age must exceed supported in-flight/recovery window. AWS abort-incomplete rules remove incomplete parts, not completed objects. No lifecycle mutation here. |
| Noncurrent versions | Bucket versioning is not established by repository code. | Account current and noncurrent GB-month separately. Version deletion needs recovery/rollback requirements and authorization; compression on new writes cannot reduce old versions. |
| Storage classes | No client storage-class policy found. Standard-IA/One Zone-IA have minimum 128 KiB billing and 30-day duration; Glacier classes add other minima/retrieval costs. | Use actual object sizes, query age and retention before class analysis. Keep active objects immediately readable. No archive transitions or expiration change. |
| Compute | `release.yml` defaults to `release-lto`; Dockerfile/build.yaml use ordinary release. Linux production allocator is jemalloc except hotpath builds. | Match executable profile and unified dependency features before timing comparisons. Extra compression CPU is a cost only at its marginal capacity rate; fixed instances require a capacity/downsizing argument. |
| Metadata cache/hot tier | `P_PARQUET_METADATA_CACHE_SIZE` defaults to 50 MiB, passed to DataFusion runtime. Hot tier is opt-in and fills objects onto local disk. | Measure hits/misses, evictions, scan age, full-object fills/refills, memory/disk and authorization first. Local manifest invalidation cannot observe publication by other nodes. No extra shared manifest cache. |

Read-only deployment evidence that would resolve the unknowns: an existing S3
Inventory export grouped by stream/time/custom partition; current/noncurrent and
incomplete-part sizes/ages; cost-and-usage line items for a representative period;
region/class and network route exports; bucket encryption and relevant policy
constraints; deployed image digest/config; workload and query-age distribution.
This investigation does not block on those unavailable inputs.

Sources:

- [AWS S3 gateway endpoints](https://docs.aws.amazon.com/vpc/latest/privatelink/vpc-endpoints-s3.html)
- [AWS S3 transfer FAQ](https://aws.amazon.com/s3/faqs/)
- [AWS S3 Bucket Keys and policy changes](https://docs.aws.amazon.com/AmazonS3/latest/userguide/bucket-key.html)
- [AWS incomplete multipart lifecycle behavior](https://docs.aws.amazon.com/AmazonS3/latest/userguide/mpu-abort-incomplete-mpu-lifecycle-config.html)
- [AWS S3 class minima, request and retrieval pricing](https://aws.amazon.com/s3/pricing/)
- [AWS billing of error responses](https://docs.aws.amazon.com/AmazonS3/latest/userguide/ErrorCodeBilling.html)

An injected 503 in a local trace proves an SDK retry, not two chargeable AWS GETs:
S3 does not bill bucket owners for service 5xx responses. Successful retransfers,
client timeouts and other error codes need their own classification.
