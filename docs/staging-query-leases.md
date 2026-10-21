# Staging Parquet query leases

Queries capture published staging Parquet files as hard links before reading the remote snapshot. The native Parquet scan owns those links through planning, repartitioning and execution. Upload cleanup can remove the original pathname without invalidating an already captured scan. Files also selected from the remote manifest are excluded from the staging scan using the uploader's canonical path mapping.

The staging filesystem must support hard links. No Parquet payload is copied into memory or onto disk. Links retain the underlying disk space until their query releases them. Capture I/O errors, including an original file disappearing before it can be linked, fail the query rather than silently omit rows. Corrupt and empty Parquet files retain the uploader's existing skip behavior.

Lease directories use `.query-parquet-*` and contain non-Parquet lease filenames. An OS file lock identifies a live owner. Stream initialization and subsequent captures reclaim unlocked orphan directories, including after a process crash; active owners and incomplete setup directories are preserved. Normal cleanup errors are logged. A crash before `.owner.lock` publication can leave an empty setup directory, but no Parquet hard links or retained data.

Tradeoffs: unique lease paths reduce staging footer-cache reuse, and standalone queries within the staging window perform an additional stream-metadata read. Query/Prism snapshot read or parse errors now fail the query instead of silently omitting a node's snapshot. No CPU, latency or cache-hit improvement is claimed.

This change covers staged-file lifetime and local/remote overlap. Memory-to-Parquet publication is a separate ownership transition; it requires the conversion-visibility fix. Stream deletion and external mutation of staging directories are not coordinated by these leases.
