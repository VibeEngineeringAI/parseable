# Memory visibility during Parquet conversion

With memory staging enabled, detaching a disk writer no longer removes its rows from the queryable memory buffers. Those buffers follow the physical Arrow source through sealing and movement into a processing directory. Conversion releases them only when their Parquet output is published, or when the source is explicitly discarded as invalid.

Query capture and Parquet publication share a short-lived lock. Capture clones the Arrow batches and records the local Parquet files; publication renames the completed output and releases its source buffers. Parquet encoding, remote storage requests and query execution run outside that lock. Arrow payloads are shared rather than copied.

This extends the current-minute retention change in PR #53 to detached writers. It requires memory staging: `ENABLE_MEMORY_STAGING=false` continues to expose only published Parquet. Failed conversions or failed sealing retain their buffers until recovery, which can use more memory than the usual staging window. A poisoned publication lock makes subsequent capture fail explicitly.

This is a local memory-to-Parquet transition guarantee. Staged-file unlinking and overlap with uploaded files are handled separately by PR #57; recovery/converter ownership is a separate concern tracked in PR #50. It does not establish an atomic snapshot across memory, local files and remote manifests. When integrating the lease change, take its file leases inside `capture_staging` before reading the refreshed remote snapshot.
