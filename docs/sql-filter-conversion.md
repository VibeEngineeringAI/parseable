# Saved SQL filter compatibility and conversion

Dataset-scoped SQL filters and upstream SQL filters using `stream_name: "sql"`
are both supported. Existing views are not automatically converted. New native
Logs views keep their dataset-scoped format until the owner chooses **Convert to
SQL view** in Saved views. Converted views still open in the original dataset;
`explorer_state` retains their dataset, query controls, time range and display
settings. Editing a converted view keeps it converted.

The native explorer reads both formats. Classic filters without native explorer
state remain visible under their original dataset, but cannot be opened or
converted by the native explorer. The literal `sql` is a reserved dataset name,
so it cannot collide with a user-created dataset.

## Backend operation

```
POST /api/v1/filters/{filter_id}/convert-to-sql
```

The endpoint takes no JSON payload and returns the complete saved filter. It
requires filter-update permission and an owner-or-admin check. Only SQL filters
can be converted. The server copies the authorized stored record, preserving
its ID, owner, query, time filter and extra metadata. Repeating the request is
safe, including after an interrupted cleanup. Admin updates also preserve the
original owner.

Ordinary create and update requests accept a valid dataset name or, for SQL
filters only, the literal `sql`. Path-like names remain invalid. A stale client
cannot turn a converted SQL filter back into a dataset-scoped one by sending its
old stream name.

## Reconciliation and recovery

Persistence uses `users/<owner>/filters/<stream>/<id>.json`. Conversion writes
the `sql` copy first, updates the server cache, then removes obsolete copies of
the same owner's filter ID. Cleanup failure returns an error, while the durable
new copy remains available for retry. Deletion removes aliases before the
current copy, so a successful deletion cannot leave an older copy to return on
restart.

Startup reconciliation groups records by owner and ID within each tenant. When
both canonical SQL and legacy SQL copies exist, it deterministically keeps the
canonical copy and removes obsolete SQL copies. A legacy record with no
canonical copy is left in its existing format. Ambiguous legacy-only duplicates
are selected deterministically without deleting the alternatives. Cleanup
failures are logged and can be retried on the next startup or conversion; there
is no one-time completion flag that could hide unfinished work.

A process-wide async lock serializes filter persistence and cache changes.
This follows the existing single-query-server ownership model: it is not a
distributed lock, and concurrent writes through multiple independent query
servers sharing the same metastore are not coordinated by this change.

Before a rollout, back up stored filter metadata and verify a legacy view can
be opened, converted, edited, restarted and deleted without reappearing. A
rollback to an older native UI will hide converted views because that UI only
understands dataset-scoped records; keep this compatible UI when rolling back
other changes. Conversion does not change log data or delete datasets.

## Regression checks

Run the isolated HTTP/restart smoke test against a newly built server:

```sh
PARSEABLE_BIN=/absolute/path/to/parseable python3 scripts/test-sql-filter-conversion.py
```

It starts its own local-store process and temporary data directories; it does not
contact an existing deployment. The fixture checks owner authorization, admin
updates, conversion retries, stale-client edits, startup cleanup of an injected
legacy duplicate, and delete followed by restart. Rust metastore tests also
exercise cleanup failures, tenant isolation, and ambiguous legacy records.
