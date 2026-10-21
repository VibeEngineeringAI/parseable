# Moving to the native UI

The server embeds the React frontend built from `frontend/`. It no longer
downloads or embeds the classic Prism distribution. The backend APIs under
`/api/prism/v1/`, Prism node mode, and existing stored dashboards remain supported.

For build inputs, deployment settings, `/next` redirects and backend-only debug
mode, see [Native UI builds](native-ui.md).

## Saved SQL and Logs views

The SQL editor includes a read-only **Server saved queries** library backed by
the existing `/api/v1/filters` API. Open a classic saved SQL query as a draft, or
copy it explicitly to the existing browser-local library. Opening a query does
not execute it, update its server record, or replace an existing browser query.
Editing and saving a browser copy does not synchronize changes to the original
server record.

In Logs, **Open in SQL editor** makes the stored SQL of an older saved view
accessible even when its explorer settings cannot be applied by the native UI.
The original view is retained. Saved definitions that contain only a classic
filter-builder expression or search, without stored SQL, cannot be translated
automatically by this migration. Recreate those filters deliberately; do not
assume an unsupported saved view was applied.

Review saved queries and views before deploying. Permissions to list saved
objects and execute their queries are checked by the server separately. An
unreadable saved time range must be reviewed before executing the query.

## Builder alerts

Open a builder alert and select **Convert to SQL rule**. The form displays the
SQL the existing rule already executes and its current settings. **Convert and
save** changes the rule to an editable SQL rule. Opening or cancelling the form
does not convert it. Existing threshold, evaluation, targets, severity and tags
are retained unless edited; the server preserves enabled and mute state.

Normal server permissions and query validation still apply. A rejected save
leaves the stored rule unchanged. Conversion does not add anomaly or forecast
alerts, which this OSS backend does not implement.

## Remaining feature differences

Removing classic assets is not a claim of complete Prism feature parity. The
remaining optional work includes dataset tags/labels and advanced schema or
partition controls; the metrics catalog, visual PromQL operations and histogram
drilldowns; Logs group-by; and the dashboard template gallery. Sample-data
generation controls, MCP connection help, and the richer classic home search
also do not have equivalent native controls.

Keystone investigations, LLM provider-key management, SQL/dashboard AI generation,
cloud billing and hosted workspace provisioning have no supported management API
in this OSS checkout. Retaining the old assets would not provide those backend
capabilities.

Existing dashboard formats remain supported. Backend dashboard persistence
changes developed independently of this migration require their own validation;
removing UI assets does not change stored dashboard revisions or deletion rules.

## Release verification

Verify login/logout and OIDC, old `/next` links and classic route bookmarks,
legacy saved queries/views, builder-alert conversion, and existing dashboards
against a disposable native-only server. Test missing hashed assets return 404
and API errors remain API errors rather than an HTML fallback. Check both a
normal frontend build and the explicit backend-only debug mode.

Build default, debug and Kafka images after changing the embedding contract.
Confirm a clean build has no upstream Prism asset fetch and the resulting
binary contains only native UI assets. Preserve package notices and comply with
the repository's AGPL license; UI replacement does not remove those obligations.
