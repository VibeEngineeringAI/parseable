# Frontend validation and independent review

This record distinguishes the current worktree's completed checks from the supplied earlier research. Original Prism source was not recovered; visual comparisons use actual rendered v3.2.4 assets and an independently implemented frontend. No deployed service or the reference checkout was modified.

## Dashboards validation (2026-10-10)

The required full `npm run check` passed: **946 unit tests in 41 files, 224 app browser tests and 46 Storybook browser tests**, without retries. The app total includes **51 dashboard browser cases**. Formatting, TypeScript, the production build and the Storybook build also passed.

Dashboard coverage now includes the real full-document save payload; sections with identical coordinates; the untyped builder fixture copied from `resources/ingest_demo_data.sh`; faithful legacy-object conversion and explicit blocked cases; ID repair; Include All defaults; removal of recognized old-type fields; UTC SQL timestamps tested in Europe/Berlin; mixed-height vertical compaction; dependency validation; capability loading/retry; file size and permissions; inline errors; focus and live-region behavior; and clipping checks at 390px and 1440px. The six axe scans wait for the lazy editor to be visible. New stories cover focusable disabled reasons, dashboard time presets/disabled state, and chart sizing. [Finding-by-finding report](#dashboards-review-dispositions) records the disposition of all four reviews and changed files.

### Second fix round

All four requested items were reverified before changes and fixed; none was rejected. The supplied verifier reproduced dollar-token blocking, incorrect movement across layout gaps and the visual defects. Regression tests reproduced the repaired-ID dirty state for owners and non-owners. Classic's `te`/`ae`/`oe` interpolators leave unknown tokens unchanged, and its variable schema allows them inside definitions.

| Item               | Status | Evidence / resolution                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------ | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Dollar tokens   | fixed  | Only defined dashboard variable names gate tile and variable queries. Unknown `$1`, `$__interval`, SQL/regex dollars and inherited-property names remain literal. Dependency cycles are checked only in consumed definition fields. Unit tests exercise interpolation, dependencies and the real query loader; browser tests render SQL and `label_replace(..., "$1", ...)` tiles and load/edit SQL and PromQL variable definitions with unknown tokens, asserting exact request and save payloads. |
| 2. ID repair       | fixed  | Repaired IDs form a clean working baseline, separate from user edits. Owner coverage verifies the next-save notice, repair-only Save, no leave prompt and Discard restoring the same IDs. Reader and admin non-owner cases verify no notice/prompt and enabled Duplicate producing fresh IDs.                                                                                                                                                                                                       |
| 3. Move order      | fixed  | Movement and first/last actions use the compacted displayed reading order. Unit and browser gap fixtures display A/B/C despite stored A/C/B; moving B earlier gives B/A/C, and later restores A/B/C. Sizes and unrelated sections remain intact.                                                                                                                                                                                                                                                    |
| 4. Layout and copy | fixed  | The x-axis title precedes the scrollable legend, dashboard charts omit the count row, and measured height reserves legend/title space. Browser checks cover wheel/keyboard access to entries beyond 64px, axis/legend bounds and aligned variable controls with errors. AI/Pie placeholders start with capitals.                                                                                                                                                                                    |

Added **10 unit tests and 5 dashboard browser cases**. The required repeated run, `npx playwright test e2e/dashboards.spec.ts --repeat-each=5 --workers=4`, passed **255/255 in 3.0m**, without retries. The dashboard unit subset passed **66 tests in 11 files** and the focused browser run passed **10/10**. The full-check totals above and the **4/4 live run against :8030** below are the final results. A transient live ingestion conversion initially reset the host options; the live retry now reselects `node-a` through the UI and requires exactly one nonempty `node-a` matrix series after network idle.

The [equivalent verification script](../scripts/verify-dashboards.mjs) completed successfully and saved 18 surface screenshots, two probes and [geometry/probe results](parity-screenshots/dashboard-round-two/report.json). Fresh [1440 light](parity-screenshots/dashboard-round-two/1440-light-02-sql-view.png), [1440 dark](parity-screenshots/dashboard-round-two/1440-dark-02-sql-view.png) and [390](parity-screenshots/dashboard-round-two/390-light-02-sql-view.png) captures were inspected directly, along with PromQL, imported-classic and mobile-editor views. The SQL plot is 85px tall at desktop and 109px at 390; its title ends above the legend. Desktop variable control tops are all 263px even with inline errors, and tile content has no measured overflow. The dollar-token demo probes reach the adapter and show its unsupported-query errors; successful query execution is verified by the mocked browser cases rather than claimed for the demo adapter.

This round changes **51 paths**, all inside `frontend/`, left uncommitted. Files below are relative to that directory:

- Variable/query handling and tests: `src/features/dashboards/variables.ts`, `variables.test.ts`, `tiles.ts`, `tiles.test.ts`, `queries.ts`, new `queries.test.ts`, `DashboardSections.tsx`, `DashboardTile.tsx`, `VariableControl.tsx`.
- Draft repair and movement: `src/features/dashboards/useDashboardDraft.ts`, `DashboardView.tsx`, `layout.ts`, `layout.test.ts`.
- Chart/layout styling: `src/features/dashboards/TileChart.tsx`, `useChartHeight.ts`, `dashboards.css`, `src/components/charts/TimeSeriesChart.tsx`, `src/components/charts/charts.css`.
- Browser verification: `e2e/dashboards.spec.ts`, `e2e-live/dashboards.spec.ts`, new `scripts/verify-dashboards.mjs`.
- Documentation: `README.md`, `docs/api-contracts.md`, `docs/component-map.md`, `docs/prism-parity.md`, `docs/validation-review.md`, `docs/wiki-drafts/prism-frontend-parity.md`.
- Evidence: 21 new files in `docs/parity-screenshots/dashboard-round-two/`, plus refreshed `docs/parity-screenshots/server-dashboard-classic.png`, `server-dashboard-created.json` and `server-dashboard-response.txt`.

### Request counts and live validation

The request-count browser case observes three tiles (filtered SQL, independent SQL and host-dependent PromQL). These are cumulative counts after each action and after network idle:

| Action                | Filtered SQL | Independent SQL | PromQL |
| --------------------- | ------------ | --------------- | ------ |
| Initial load          | 1            | 1               | 1      |
| Time range            | 2            | 2               | 2      |
| Host variable         | 2            | 2               | 3      |
| Level variable        | 3            | 2               | 3      |
| Refresh               | 4            | 3               | 4      |
| Move                  | 4            | 3               | 4      |
| Variable label edit   | 4            | 3               | 4      |
| Other tile title edit | 4            | 3               | 4      |
| Save                  | 4            | 3               | 4      |

The case asserts no alert flash on initial load and no native leave prompt during dirty search-only navigation, and attaches `tile-request-counts.json`; the [actual request-count attachment](parity-screenshots/dashboard-request-counts.json) is saved here. It counts tile requests separately from variable metadata queries. Text typing tests check caret position, all characters, debounce, Enter and blur.

The dashboard live suite passed **4/4 in 16.0s**, without retries. It ingested twelve logs and two OTLP gauge series, created SQL/table and PromQL/timeseries tiles and dataset/label-values variables through the UI, and compared each stored tile exactly, including config and layout. Classic hard-load showed log rows, the selected `node-a`, and nonempty PromQL matrix data, with no captured page errors. The reverse check uses a literal JSON fixture copied from research report 2.6, adapted only for this run's datasets and test extras; it verifies data and exact preservation after a title edit. The fourth case confirms all created IDs appear with `limit=0`, and admin DELETE succeeds while PUT of another owner's document returns the exact owner-permission 400 text. Cleanup removed all created dashboards, both datasets, the reader user and its role.

[Classic capture](parity-screenshots/server-dashboard-classic.png), [formatted stored JSON](parity-screenshots/server-dashboard-created.json), and the [verbatim server response](parity-screenshots/server-dashboard-response.txt) record the new live run. The author hash is SHA-256 of the disposable username `admin`; the capture contains test data. The formatted JSON is not described as verbatim bytes.

Vite used `http://127.0.0.1:8271`, proxying only to disposable `http://127.0.0.1:8030`. Both origins must use the same host to share login cookies across ports; the live spec fails clearly before ingest if their hostnames differ. Completed checks and fresh captures used Chromium `/usr/bin/chromium` and `TMPDIR=/home/ajs/.cache/dash-tmp`. Browser invocations used `flock /home/ajs/.cache/parseable-playwright.lock` and checked ports 5173/6006 inside the lock. No request was sent to ports 8000, 8011 or 8012. Vite was stopped afterwards and port 8271 is free.

Import and Duplicate strip `tenantId` and preserve `dashboardType`, so Report copies can be created; the Create form creates Dashboard documents. Sections render in stored order with independent grids; section creation, renaming, reordering and collapsing remain out of scope. AI/Enterprise/templates, visual builder authoring, drag/resize, present/PNG and auto-refresh remain excluded. Bar/area still use the shared line renderer. Complex legacy filters are conservatively blocked from SQL conversion. No deployment, embedded `/next` rebuild, cross-browser run or pixel-parity claim is included.

The requested follow-ups are **per-item local-import progress and per-account offering**, and **relative-range re-anchoring without Refresh**. The import marker remains batch-level, with an explanatory code comment. Relative ranges hold their anchor until a range change or Refresh, matching classic. No commits, pushes or git-state changes were made.

### Dashboards review dispositions

Findings were rechecked against the original source, Rust handlers and classic chunks before changes. No reported behavioral defect was rejected. The two requested deferrals are explicit below; quality #24 records a positive informational observation rather than a requested change.

**Contract review**

| Finding | Status   | Evidence / resolution                                                                                                                                                   |
| ------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #1      | fixed    | Each section has its own grid in classic order; orphan/unsectioned tiles are first. Pure and browser tests use identical x/y in two sections; definitions remain exact. |
| #2      | fixed    | Missing tileType is builder. Literal ingest_demo_data.sh fixture renders and converts in unit/browser tests.                                                            |
| #3      | fixed    | Include All is first and selected without a stored default; unit coverage and demo assertions verify it.                                                                |
| #4      | fixed    | Moves swap neighbour coordinates and compact only that section. Mixed-height tests retain unrelated columns and stored w/h.                                             |
| #5      | fixed    | Legacy-object conversion matches classic time_bucket, uppercase aliases, grouping, order and limits. Unsupported filters are blocked; SQL Apply always writes a string. |
| #6      | deferred | As requested: per-item import persistence and per-account offering. LocalImportNotice explains its batch-level marker and interrupted-batch behavior.                   |
| #7      | fixed    | Classic builder (and AI) alert URLs open SQL mode; exact unit and browser handoff checks.                                                                               |
| #8      | fixed    | Language/type changes remove only recognized fields of the old type; unknown fields survive exact unit comparisons.                                                     |

**Functional review**

| Finding | Status   | Evidence / resolution                                                                                                                                                                                                                                                |
| ------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #1      | fixed    | SQL chart timestamps use parseEventTimestamp. Europe/Berlin unit case checks offset-less UTC and explicit offsets.                                                                                                                                                   |
| #2      | fixed    | Query inputs use committed URL values; readiness requires validated selection already in that URL. Request counters and a MutationObserver prove one round and no initial alert flash.                                                                               |
| #3      | fixed    | Text has a local draft, 400ms debounce and Enter/blur commits; browser assertions check characters and caret.                                                                                                                                                        |
| #4      | fixed    | Loaders key only consumed query/option fields, referenced values, effective bounds and refresh; variable labels, defaults and stale fields of other types are excluded. Static options do not reload for time bounds; valid options/data remain during revalidation. |
| #5      | fixed    | Pure vertical compaction pushes resize collisions and closes deletion gaps. Mixed-height unit tests and browser geometry show no overlaps.                                                                                                                           |
| #6      | fixed    | Moves swap neighbours before vertical compaction, rather than repacking rows. Unrelated columns retain their positions.                                                                                                                                              |
| #7      | fixed    | Load repairs repeated and nil IDs in a clean working baseline; only owners see the next-save notice. Discard retains those IDs, and non-owners can leave/duplicate. Editing/deleting affect only the chosen tile.                                                    |
| #8      | fixed    | Conflict Cancel preserves the dirty draft after a failed Overwrite; list recovery also retains its dirty flag. Browser cases return to editing and reject an attempted navigation.                                                                                   |
| #9      | fixed    | Dependent options wait for upstream readiness and validated URL value. DFS rejects cycles among defined variables in consumed option fields; unknown dollar tokens pass through like classic. Unit and delayed-source browser tests.                                 |
| #10     | fixed    | Unknown capabilities show loading, failures offer Retry, and ownership loading suppresses the read-only note; MutationObserver checks owner flash.                                                                                                                   |
| #11     | fixed    | Import rejects files over 5 MB before file.text(); browser case verifies no POST and empty paste field.                                                                                                                                                              |
| #12     | fixed    | Stat follows the user decision: configured field, otherwise first numeric column of last row, numeric strings accepted; PromQL reads Value rather than Samples. Hint and tests document it.                                                                          |
| #13     | deferred | As requested: relative ranges retain their anchor until range change or Refresh, matching classic. Documented here and in API/parity docs.                                                                                                                           |
| #14     | fixed    | List Duplicate respects create permission. Favourite negates the freshly fetched row; stale-row and ingestor browser tests.                                                                                                                                          |
| #15     | fixed    | Demo GET/PUT/DELETE missing-ID messages and existence/tile-validation/owner order match Rust exactly; unit tests assert the text/order.                                                                                                                              |
| #16     | fixed    | Height keeps a clearable local string and validates before Apply; browser backspace/type-8 test persists h:8.                                                                                                                                                        |

**Accessibility and UX review**

| Finding | Status | Evidence / resolution                                                                                                                                                                                                                                 |
| ------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #1      | fixed  | Scoped dashboard title-cell override; actual link/cell bounding boxes at 390/1440 catch ancestor clipping. Global rules are unchanged for Logs, Team and Alerts.                                                                                      |
| #2      | fixed  | Server tiles use their own class, restoring 16px padding. Axis space scales to formatted label length; desktop geometry verifies it exceeds 64px.                                                                                                     |
| #3      | fixed  | Measured chart body height reserves axis titles and a scrollable legend; the x title precedes the legend and compact tiles omit the visible count row. Browser checks compare scrollHeight/clientHeight and x-title bounds; only table bodies scroll. |
| #4      | fixed  | Shared useRowDeletionFocus restores neighbour/Add focus. Save, Discard and Reload focus the heading; explicit browser assertions cover each.                                                                                                          |
| #5      | fixed  | Reasons are visible, focusable aria-disabled items with aria-describedby. Create alert, unsaved Duplicate, capability-disabled Edit and favourite are guarded against activation.                                                                     |
| #6      | fixed  | Saved status clears on dirty state. Move/Duplicate/Delete/Refresh and Apply announce through one polite region; repeats reset the message and initial load stays empty.                                                                               |
| #7      | fixed  | Compact inline variable error names its label, describes its select and offers a named Retry; browser checks height and accessible description.                                                                                                       |
| #8      | fixed  | Tiles distinguish failed variables from unselected values; query failures remain inline with Retry/View query and no Explore demo data.                                                                                                               |
| #9      | fixed  | Placeholders name their chart/tile type and preservation. Classic link uses server-root dashboard path only under a non-root base in live mode, with new-tab cue.                                                                                     |
| #10     | fixed  | Add variable/Add tile share one spaced action row and button size; variable controls remain aligned even when inline errors appear.                                                                                                                   |
| #11     | fixed  | Header buttons share sizing, filters group together, and column-header sort buttons were removed in favor of select/direction controls.                                                                                                               |
| #12     | fixed  | Visible and accessible sort labels are both Sort ascending/descending; date-order browser tests use those labels.                                                                                                                                     |
| #13     | fixed  | Clearable height local string; validation and type-8 browser regression.                                                                                                                                                                              |
| #14     | fixed  | SQL and PromQL editors have visible labels in tile and variable dialogs.                                                                                                                                                                              |
| #15     | fixed  | Editor/import fields autofocus; deletion/conversion/conflict dialogs focus Cancel. Browser/story tests verify initial focus.                                                                                                                          |
| #16     | fixed  | Detail rename uses Apply and explicitly says Save keeps the changes.                                                                                                                                                                                  |
| #17     | fixed  | Non-scrolling tile cards no longer add tabindex=0; scrolling tables retain their result-region focus stop.                                                                                                                                            |
| #18     | fixed  | Read-only viewers get a duplication suggestion when allowed and appropriate empty states. No variables means no empty variables landmark.                                                                                                             |
| #19     | fixed  | Singular/plural copy is correct; permanent dismissal says Don’t ask again; failed local imports share one alert.                                                                                                                                      |
| #20     | fixed  | Stat uses role=group with its contextual accessible label.                                                                                                                                                                                            |
| #21     | fixed  | Left/right legends occupy actual side columns; browser resize/config test compares legend and plot geometry.                                                                                                                                          |
| #22     | fixed  | Tile loading uses aria-busy/plain text; chart series announcements are off for dashboard tiles. Refresh uses the one page status region.                                                                                                              |

**Tests and quality review**

| Finding | Status   | Evidence / resolution                                                                                                                                                                                                                                |
| ------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #1      | fixed    | Production uses extracted loadDraft/applyTile/dashboardPayload; round-trip test reaches real GET-conflict/PUT client path. Test-only patchTile removed; missing timeRange case retained.                                                             |
| #2      | fixed    | Charts assert series counts; tables/stat assert data. Live reverse also inspects successful nonempty matrix results.                                                                                                                                 |
| #3      | fixed    | Live reverse fixture is literal JSON copied from report 2.6 and does not import chartConfig.                                                                                                                                                         |
| #4      | fixed    | Each editor axe scan waits for the lazy dialog before analysis.                                                                                                                                                                                      |
| #5      | fixed    | Demo stat asserts numeric text; edit/delete waits for saved state and deletion is checked after leaving/reopening.                                                                                                                                   |
| #6      | fixed    | Adapter isolation is asserted before deletion, and saved title is exact.                                                                                                                                                                             |
| #7      | fixed    | Live spec checks matching hostname before ingest; README and this runbook explain host-scoped cross-port cookies.                                                                                                                                    |
| #8      | fixed    | Untyped legacy-object builder is converted/saved exactly with string SQL; unit negative cases block unsupported semantics. Old PromQL fields are removed.                                                                                            |
| #9      | fixed    | Import/Duplicate strip tenantId and retain dashboardType; docs explicitly include creation of Report copies.                                                                                                                                         |
| #10     | fixed    | Dashboard counts now match the completed required check: 946 unit, 224 app browser, 46 Storybook browser, including 51 dashboard cases. Earlier dated validation results remain historical records. Metadata has named unit coverage.                |
| #11     | fixed    | Vacuous guard assertion dropped; readVariables test proves unknown types skip the UI while full document keeps them. Guard comment corrected.                                                                                                        |
| #12     | fixed    | Live stored tiles use toEqual with full literal config/layout and only generated IDs matched flexibly.                                                                                                                                               |
| #13     | fixed    | Negative network cases wait for populated options and network idle before checking absent requests.                                                                                                                                                  |
| #14     | fixed    | Reader/admin/ingestor cases inspect all owner controls, non-owner favourites and create permission; list conflict Cancel retains its dirty navigation guard, and stale favourite is covered.                                                         |
| #15     | fixed    | 390px checks action and Apply boxes before focus, plus title-cell clipping and chart content.                                                                                                                                                        |
| #16     | fixed    | Exact handoff params, SQL strings and sort order; unsupported conversion, SQL All and placeholder-prefix cases added. Created/updated sorts use distinct dates.                                                                                      |
| #17     | fixed    | Metadata request/bounds helpers and source type moved to lib and reused by Metrics/Alerts/Dashboards; six unit cases; dead imports removed.                                                                                                          |
| #18     | fixed    | DashboardView and TileEditor are below about 300 lines, with cohesive URL/draft/dialog/layout/query/appearance modules and pure transitions. Per-domain client splitting remains an eventual suggestion outside this dashboard task.                 |
| #19     | fixed    | Result helpers moved to lib/promqlResults, guards to lib/guards; exported storage key; merged imports and removed owner alias. hasConflict is private and tested through production caller. Shared SqlEditor remains reused, consistent with Alerts. |
| #20     | fixed    | New ActionsMenu and TimeRangePicker stories/tests exercise reason, presets and disabled props; existing story tests/count assertions are unchanged. A chart sizing story covers new chart props too.                                                 |
| #21     | fixed    | Request-count case explicitly observes zero native prompts during dirty URL/search-only changes. Existing shared hook/runtime/worker settings were not edited; no commit splitting because user forbids git changes.                                 |
| #22     | fixed    | Independent reverse/ownership checks no longer skip after primary failure; list verifies all created IDs; classic checks page errors, selected host and successful matrix data.                                                                      |
| #23     | fixed    | Updated artifact is called formatted JSON; verbatim bytes have their own .txt artifact. Disposable admin SHA-256 is documented, with no secret credential in the artifact.                                                                           |
| #24     | rejected | Informational clean-areas finding, not a defect/change request. Verified shared hooks, independent mocks and no any/eslint-disable/ts-expect-error additions.                                                                                        |

The conservative legacy conversion boundary is deliberate: unsupported complex filter operators produce a clear blocking message and preserve the original tile. The pre-save GET/PUT conflict check still has a server-side race window because the API has no conditional revision write. No uncertainty remains about the tested core behaviors; broader renderer/pixel parity and real screen-reader behavior were not validated by this Chromium run.

### Stored server response

Verbatim JSON from the successful live create/save/GET run:

<!-- prettier-ignore -->
```json
{"version":"v1","title":"Dashboards live mv2l3ix7_4c1b439a","author":"8c6976e5b5410415bde908bd4dee15dfb167a9c873fc4bb8a81f6f2ab448a918","dashboardId":"01M4K8WXWV60JHPAC7FNZEYJYE","created":"2026-10-10T16:03:53.371681040Z","modified":"2026-10-10T16:03:55.076120105Z","tags":["parity","live"],"isFavorite":false,"dashboardType":"Dashboard","tiles":[{"tile_id":"01M4K8WYW40H6JN8KV9G6PB6NR","title":"Live log events","authorMode":"manual","tileType":"code","chartType":"table","chartQuery":"SELECT * FROM \"dash_logs_mv2l3ix7_4c1b439a\" ORDER BY \"p_timestamp\" DESC LIMIT 12","dbName":["dash_logs_mv2l3ix7_4c1b439a"],"layout":{"x":0,"y":0,"w":12,"h":4},"config":{"type":"table","colourScheme":"classic","layout":{"legendPosition":"bottom","segments":{"value":[10,90],"isPercent":true},"label":false},"axes":{"x":{"field":"","title":"","display":true},"y":{"field":"","title":"","display":true,"beginAtZero":false}},"advanced":{"dataLabels":{"enabled":false},"tooltip":{"enabled":true,"mode":"index","intersect":false}}}},{"tile_id":"01M4K8WZ42QWC5QXVWW3JBPP57","title":"Live host load","authorMode":"manual","tileType":"promql","chartType":"timeseries","chartQuery":["{__name__=\"frontend.dashboards.load_mv2l3ix7_4c1b439a\",host=~\"$host\"}"],"dbName":"$metrics_dataset","layout":{"x":0,"y":4,"w":12,"h":4},"config":{"type":"timeseries","colourScheme":"classic","layout":{"legendPosition":"bottom","segments":{"value":[10,90],"isPercent":true},"label":false},"axes":{"x":{"field":"","title":"","display":true},"y":{"field":"","title":"","display":true,"beginAtZero":false}},"advanced":{"dataLabels":{"enabled":false},"tooltip":{"enabled":true,"mode":"index","intersect":false}}},"promqlQueryType":["range"]}],"tenantId":null,"description":"SQL and PromQL classic interchangeability","variables":[{"name":"metrics_dataset","label":"Metrics dataset","type":"dataset","defaultValue":"dash_metrics_mv2l3ix7_4c1b439a"},{"name":"host","label":"Host","type":"promql","dataset":"$metrics_dataset","labelName":"host","metric":"frontend.dashboards.load_mv2l3ix7_4c1b439a","includeAll":true,"defaultValue":"node-a"}],"sections":[],"timeRange":{"startTime":"1h","endTime":"now","type":"fixed","label":"Last 1 hour","interval":3600000,"shiftInterval":1}}
```

### First fix round changed files

The first fix round changed 80 paths inside `frontend/`; this historical list is relative to that directory. The second round's files are recorded above. Git state was only read for inspection.

- `README.md`
- `docs/api-contracts.md`
- `docs/component-map.md`
- `docs/parity-screenshots/dashboard-request-counts.json`
- `docs/parity-screenshots/server-dashboard-classic.png`
- `docs/parity-screenshots/server-dashboard-created.json`
- `docs/parity-screenshots/server-dashboard-response.txt`
- `docs/prism-parity.md`
- `docs/validation-review.md`
- `docs/wiki-drafts/prism-frontend-parity.md`
- `e2e-live/dashboards.spec.ts`
- `e2e-live/fixtures/classic-dashboard.json`
- `e2e/dashboards.spec.ts`
- `src/components/charts/TimeSeriesChart.stories.tsx`
- `src/components/charts/TimeSeriesChart.tsx`
- `src/components/explorer/TimeRangePicker.stories.tsx`
- `src/components/explorer/TimeRangePicker.tsx`
- `src/components/promql/completion.ts`
- `src/components/ui/ActionsMenu.stories.tsx`
- `src/components/ui/ActionsMenu.tsx`
- `src/components/ui/ui.css`
- `src/features/alerts/helpers.test.ts`
- `src/features/alerts/helpers.ts`
- `src/features/dashboards/ConflictDialog.tsx`
- `src/features/dashboards/DashboardDialogs.tsx`
- `src/features/dashboards/DashboardForm.tsx`
- `src/features/dashboards/DashboardSections.tsx`
- `src/features/dashboards/DashboardTile.tsx`
- `src/features/dashboards/DashboardView.tsx`
- `src/features/dashboards/DashboardsList.tsx`
- `src/features/dashboards/DashboardsPage.tsx`
- `src/features/dashboards/ImportDialog.tsx`
- `src/features/dashboards/LocalImportNotice.tsx`
- `src/features/dashboards/TileAppearanceFields.tsx`
- `src/features/dashboards/TileChart.tsx`
- `src/features/dashboards/TileEditor.tsx`
- `src/features/dashboards/TileQueryFields.tsx`
- `src/features/dashboards/VariableControl.tsx`
- `src/features/dashboards/VariableEditor.tsx`
- `src/features/dashboards/VariablesBar.tsx`
- `src/features/dashboards/__fixtures__/ingest-demo-tile.json`
- `src/features/dashboards/chartValue.test.ts`
- `src/features/dashboards/chartValue.ts`
- `src/features/dashboards/dashboards.css`
- `src/features/dashboards/draft.test.ts`
- `src/features/dashboards/draft.ts`
- `src/features/dashboards/handoffs.test.ts`
- `src/features/dashboards/helpers.test.ts`
- `src/features/dashboards/helpers.ts`
- `src/features/dashboards/importExport.test.ts`
- `src/features/dashboards/importExport.ts`
- `src/features/dashboards/layout.test.ts`
- `src/features/dashboards/layout.ts`
- `src/features/dashboards/legacySql.ts`
- `src/features/dashboards/owner.ts`
- `src/features/dashboards/queries.ts`
- `src/features/dashboards/storage.ts`
- `src/features/dashboards/tileEditing.ts`
- `src/features/dashboards/tiles.test.ts`
- `src/features/dashboards/tiles.ts`
- `src/features/dashboards/timeRange.ts`
- `src/features/dashboards/useChartHeight.ts`
- `src/features/dashboards/useDashboardDraft.ts`
- `src/features/dashboards/useDashboardUrl.ts`
- `src/features/dashboards/variables.test.ts`
- `src/features/dashboards/variables.ts`
- `src/features/metrics/LabelBrowser.tsx`
- `src/features/metrics/MetricsPage.tsx`
- `src/features/metrics/helpers.ts`
- `src/lib/dashboardsClient.test.ts`
- `src/lib/dashboardsContract.test.ts`
- `src/lib/dashboardsContract.ts`
- `src/lib/demoDashboards.test.ts`
- `src/lib/demoDashboards.ts`
- `src/lib/guards.ts`
- `src/lib/promqlMetadata.test.ts`
- `src/lib/promqlMetadata.ts`
- `src/lib/promqlResults.ts`
- `src/lib/teamContract.ts`
- `story-tests/dashboard-controls.spec.ts`

Commands from `frontend/`:

```sh
npm run format
flock /home/ajs/.cache/parseable-playwright.lock bash -c '
  while ss -H -ltn "( sport = :5173 or sport = :6006 )" | rg -q .; do sleep 2; done
  export TMPDIR=/home/ajs/.cache/dash-tmp
  export PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium
  export PARSEABLE_PROXY_TARGET=http://127.0.0.1:8030
  npm run check
  while ss -H -ltn "( sport = :5173 or sport = :6006 )" | rg -q .; do sleep 2; done
  npx playwright test e2e/dashboards.spec.ts --repeat-each=5 --workers=4
'

flock /home/ajs/.cache/parseable-playwright.lock bash -c '
  while ss -H -ltn "( sport = :5173 or sport = :6006 )" | rg -q .; do sleep 2; done
  export TMPDIR=/home/ajs/.cache/dash-tmp
  export PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium
  export PARSEABLE_PROXY_TARGET=http://127.0.0.1:8030
  export PARSEABLE_DEMO=true
  npx vite --host 127.0.0.1 --port 5173 --strictPort > "$TMPDIR/dashboard-capture-vite.log" 2>&1 &
  dashboard_capture_pid=$!
  trap "kill $dashboard_capture_pid; wait $dashboard_capture_pid" EXIT
  until curl -fsS http://127.0.0.1:5173/ > /dev/null; do sleep 1; done
  node scripts/verify-dashboards.mjs
'

PARSEABLE_PROXY_TARGET=http://127.0.0.1:8030 \
  npx vite --host 127.0.0.1 --port 8271 --strictPort

flock /home/ajs/.cache/parseable-playwright.lock bash -c '
  while ss -H -ltn "( sport = :5173 or sport = :6006 )" | rg -q .; do sleep 2; done
  export TMPDIR=/home/ajs/.cache/dash-tmp
  export PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium
  export PARSEABLE_LIVE_URL=http://127.0.0.1:8271 PARSEABLE_LIVE_BASE=
  export PARSEABLE_LIVE_SERVER_URL=http://127.0.0.1:8030
  export PARSEABLE_LIVE_USERNAME=admin PARSEABLE_LIVE_PASSWORD=admin
  npx playwright test -c playwright.live.config.ts e2e-live/dashboards.spec.ts
'
```

## Alerts validation (2026-10-09)

This section records the frontend fixes and completed checks for the four supplied Opus reviews.

| Check                             | Actual result                                                                   | Scope                                                                                                                                                          |
| --------------------------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run format`                  | Passed                                                                          | Source, browser/live tests, stories and frontend docs                                                                                                          |
| Required `npm run check`          | **800 unit tests (22 files), 172 app browser tests, 42 Storybook tests passed** | Formatting, TypeScript, production build, Vitest, demo/mocked HTTP app tests, Storybook build and browser tests                                                |
| Alerts app browser suite          | **61 passed** in the full check                                                 | CRUD, routing, SQL handoff, duplicate validation, duration round-trips, tags, validation, focus, announcements, runtime tables, preview and chart preservation |
| Repeated dark accessibility tests | **60/60 passed in 50.2s**, zero failures or retries                             | Alerts **50/50** across five views and Metrics **10/10**, with `--repeat-each=10 --workers=6`                                                                  |
| Rust duration compatibility       | **93 parser-oracle cases passed: 59 accepted, 34 rejected**                     | Fixture generated with the actual Cargo.lock dependency, humantime 2.3.0; aliases, compound/fractional units, precision and overflow boundaries                |
| Alerts accessibility and layout   | Passed                                                                          | Ten desktop light/dark axe scans; keyboard scrolling and axe for runtime, delivery and preview tables at 390px; Tags/Actions geometry at 1024px                |
| Isolated components               | Included in the **42 Storybook tests** above                                    | ArrowUp wrap-around, disabled menu exposure, open-menu dark axe, threshold-story light/dark axe, threshold canvas strokes and uPlot identity/value changes     |
| Alerts live suite via Vite        | **3 passed in 11.4s**                                                           | Native admin session at `http://127.0.0.1:8270`, proxying to the disposable server on port 8010                                                                |
| Live cleanup and seeded inventory | Verified; Vite stopped                                                          | Before/after inventories retain three seeded alerts, two targets and three datasets; the suite's unique fixtures are gone                                      |

The regression coverage verifies these review fixes:

- Dark axe scans assert the applied theme, emulate reduced motion, disable CSS animation/transition motion for the snapshot and await all remaining `document.getAnimations()` promises. The same setup covers Alerts, Metrics, Team and app scans. Earlier attempts exposed CodeMirror's infinite caret animation and residual 0.01ms transitions that could stall; the final full check and repeated run passed without retries.
- Runtime instances, deliveries and preview tables expose named, focusable scroll regions. Named action IDs keep Disable/Enable and Mute/Unmute focused after toggling and remove positional/label coupling.
- Runtime chart data and references are memoized. Equivalent threshold and range values preserve the uPlot instance; changed values update it.
- Duplicate navigation state is validated with the alerts contract guard. Builder alerts do not offer Duplicate, and invalid or builder source state displays an explanation. Trailing-slash routes resolve correctly, and both `queryBuilderType=sql` and `code` select SQL.
- Tag rows have stable IDs, blank tags are omitted from requests, and nonblank tags preserve whitespace, commas and duplicates. Adding/removing tags and target headers moves focus to a sensible control. Theme changes preserve an untouched edit draft.
- Evaluation-window and hold-duration validation matches humantime aliases, including `10mins`, `2hrs` and `30secs`. Existing accepted durations can be saved unchanged.
- Disabled Create/Save controls have immediately visible field errors, including an invalid prefilled query. Runtime/state badges use human labels. Preview numbers are rounded for display with the raw values in titles.
- Persistent live regions announce list/detail actions, target creation and preview completion. Tags wrap within their column at 1024px without being covered by Actions.
- List-menu tests assert mute and unmute results; chart/card loops first assert a positive state. The live delete-focus assertion accepts search when the table becomes empty. The accessibility smoke loop includes `with-thresholds`.

The existing permission/session, held-save, dirty-form, reader/capability, cancellation and deletion-focus regressions also passed. Permission errors retain the session and draft; genuine session expiry still recovers.

The live spec creates a unique `alerts_live_*` OTLP dataset with two gauge series (3.25 and 7.5), a webhook target and a PromQL rule. It compares preview values with the API, verifies evaluation through a successful PUT and a strictly newer runtime timestamp, checks mute/unmute and disable/enable, then edits hold duration and performs typed deletion. Cleanup touches only these unique fixtures. Authenticated before/after inventories matched: the three seeded alerts, `ops-slack`, `ops-webhook`, `pstats`, `shots_logs` and `shots_metrics` remain. Port 8270 had no listener after Vite was stopped.

No fresh screenshot inspection, contract-probe sweep, embedded-server validation, cross-browser check or classic-UI pixel comparison was performed in this follow-up. Shared collection/mutation hook extraction, badge-colour/sort-header deduplication and lib-to-feature import cleanup remain deferred.

Commands from `frontend`:

```sh
npm run format

TMPDIR=/home/ajs/.cache/alerts-tmp \
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium \
PARSEABLE_PROXY_TARGET=http://127.0.0.1:8010 npm run check

TMPDIR=/home/ajs/.cache/alerts-tmp \
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium \
PARSEABLE_PROXY_TARGET=http://127.0.0.1:8010 \
npx playwright test e2e/alerts.spec.ts e2e/metrics.spec.ts \
  --grep 'passes axe in dark|accessible light/dark results' \
  --repeat-each=10 --workers=6

PARSEABLE_PROXY_TARGET=http://127.0.0.1:8010 \
npx vite --host 127.0.0.1 --port 8270

TMPDIR=/home/ajs/.cache/alerts-tmp \
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium \
PARSEABLE_LIVE_URL=http://127.0.0.1:8270 PARSEABLE_LIVE_BASE= \
PARSEABLE_LIVE_USERNAME=admin PARSEABLE_LIVE_PASSWORD=admin \
npx playwright test -c playwright.live.config.ts e2e-live/alerts.spec.ts
```

## Metrics explorer validation (2026-10-09)

| Check                  | Actual result                                            | Scope                                                                                                                                                                                                                                             |
| ---------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run check`        | **487 unit, 107 app browser, 33 Storybook tests passed** | Format, TypeScript, build, Vitest, Playwright (demo and mocked HTTP, including axe), Storybook story tests                                                                                                                                        |
| Live suite via Vite    | **14 passed, 3 opt-in OIDC skips**                       | `server.spec.ts`, `team.spec.ts` and `metrics.spec.ts` at `http://127.0.0.1:8370` (`PARSEABLE_LIVE_BASE=`), proxying to a disposable v3.2.5 local-store server with `P_PROMQL_MAX_INGEST_DELAY=0`                                                 |
| Embedded `/next` build | **14 passed, 3 opt-in OIDC skips**                       | Rust rebuilt with `NEXT_ASSETS_PATH` set to a snapshot of the checked `dist`; `PARSEABLE_LIVE_URL=http://127.0.0.1:8360` with the default `/next` base                                                                                            |
| Contract probe         | Matched                                                  | PromQL routes answer at `/prometheus/api/v1/*`; `/api/v1/prometheus/*` returns 404. Quoted dotted metric and label names (`{"a.b", "service.name"="x"}`, `by ("service.name")`) parse in `@prometheus-io/lezer-promql` and evaluate on the server |
| Mobile                 | No horizontal overflow at 390x844                        | Live data, range query                                                                                                                                                                                                                            |

The metrics live spec ingests a gauge and a cumulative counter with two `host` values into a fresh `metrics_live_*` dataset through `POST /v1/metrics`. It checks the label browser, then compares the gauge and `sum by (host) (rate(...[5m]))` results with the API response, checks that `topk` shows the verbatim 422 message, and deletes the dataset. Vite proxies `/v1` so ingestion works through the dev server.

Run Playwright with `TMPDIR` on a disk-backed directory when `/tmp` is a small tmpfs. Chromium leaves `.org.chromium.Chromium.*` scratch directories behind, and they filled a per-user `/tmp` quota during this validation. With `/tmp` full, both the server's staging writes and Chromium fail with `ERR_INSUFFICIENT_RESOURCES`.

## Team page validation (2026-10-08)

| Check                                             | Actual result                                                                                          | Scope                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Default check                                     | `npm run check` passed: **152 unit tests (9 files), 69 app browser tests, 14 Storybook browser tests** | Formatting, TypeScript, production build and Storybook build in the same command. Team browser tests use demo data and mocked HTTP; the run followed the root-admin and empty-state fixes                                                                                                                          |
| Worktree Rust build                               | `cargo build --locked --bin parseable` passed (incremental, 22s)                                       | Debug local-store executable with OIDC configured against the mock provider                                                                                                                                                                                                                                        |
| API contract probe                                | `curl` against the disposable server matched the client                                                | `POST /user/{name}` returned a 32-character `text/plain` password; unknown roles returned JSON `non_existent_roles`; `PUT /role/default` took a JSON string; deleting the default role returned the expected 400; API-key create returned the full key, and the list returned `****` plus the last four characters |
| Live suite                                        | **12 passed, 2 opt-in OIDC skips in 37.1s**                                                            | `server.spec.ts` plus the six `team.spec.ts` tests against the real backend through Vite on port 8270 (`PARSEABLE_LIVE_BASE=`). The server had a pre-existing default OIDC role, and the suite restored it                                                                                                         |
| Live SSO                                          | **1 passed** with `PARSEABLE_LIVE_OIDC=true`                                                           | Created a real OAuth user whose only role came from the provider group                                                                                                                                                                                                                                             |
| Embedded `/next` build                            | **6 passed in 19.2s** (`e2e-live/team.spec.ts`)                                                        | Rust rebuilt with `NEXT_ASSETS_PATH` pointing at a snapshot of the checked `dist`; `PARSEABLE_LIVE_URL=http://127.0.0.1:8250` with the default `/next` base                                                                                                                                                        |
| Embedded `/next` full live suite, after the fixes | **12 passed, 1 failed, 1 skipped**                                                                     | All `server.spec.ts` and `team.spec.ts` cases passed at `http://127.0.0.1:8250/next` except SSO. Its mock-provider logout returned to `8250` while the fixture callback origin is `8270`; the SSO case passed again at `8270`                                                                                      |
| OAuth role sources                                | Remove stayed disabled, with "This role has no manual grant to remove…"                                | Real provenance from `GET /user/{id}/role` (`legacy: false`, provider role only, no manual roles)                                                                                                                                                                                                                  |

Commands, from `frontend`, with the backend, the mock provider and Vite started as described below:

```sh
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium npm run check
PARSEABLE_LIVE_URL=http://127.0.0.1:8270 PARSEABLE_LIVE_BASE= \
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium npm run test:live
PARSEABLE_LIVE_OIDC=true PARSEABLE_LIVE_URL=http://127.0.0.1:8270 PARSEABLE_LIVE_BASE= \
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium npm run test:live -- --grep SSO
```

The first live run failed one assertion. The test expected HTTP 401 for the old password after a reset, but the backend answers any invalid Basic credentials with 403; only missing credentials get 401. The assertion now expects 403. A later run showed that the suite's default-role restore sent the role name as text, not JSON. It was corrected before the passing run above.

Not verified: enterprise user groups and SaaS invites (out of scope), and the distributed query server's user and role paths.

## Completed current validation (2026-10-07)

| Check                                  | Actual result                                                                                      | Scope                                                                                                                                 |
| -------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Worktree Rust build                    | `cargo build --locked --bin parseable` passed; final crate rebuild 46s after dependencies compiled | Real local-store executable, using a stable editable asset snapshot. `--help` and `local-store --help` also passed                    |
| Live backend                           | Port 8250 liveness returned 200; synthetic logs ingested into `frontend_smoke`                     | Disposable storage under `/tmp/astra-item2-data`; no deployed data                                                                    |
| Independent final live Playwright pass | **7 passed, 1 expected skip in 20.1s**                                                             | Final current code: native/session/logs/SQL/schema plus mock OIDC and administrative API denial; missing-provider test ran separately |
| Authenticated original Prism capture   | Four original routes rendered with no captured JavaScript page errors                              | Logs, initial SQL, datasets and empty server-dashboard listing, native fixture account; 1440 × 1000                                   |
| Final implementation capture           | Login and four supported routes refreshed after layout refinements; mobile login/Logs at 390 × 844 | Real native session, no API mocking; original/editable screenshots composed side by side                                              |

The final OIDC-configured live command was:

```sh
cd frontend
npm_config_cache=/tmp/astra-item2-npm \
TMPDIR=/tmp/astra-item2-tmp \
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium \
PARSEABLE_LIVE_URL=http://127.0.0.1:8270 \
PARSEABLE_LIVE_OIDC=true \
npm run test:live
```

Assertions verified backend invalidation by reusing the old native session cookie and receiving HTTP 401. A missing browser session and a server-invalidated session both returned to login, retained the intended dataset route and recovered after sign-in. The log test used ingested values, applied an exact ERROR filter, opened details using Enter and checked Escape focus restoration. SQL ran on DataFusion and a missing-table query produced a real error with stale results removed. The dataset sheet showed Arrow-schema fields and navigated back to logs.

The final OIDC case also confirmed that the restricted user received HTTP 403 from the administrative `/api/v1/roles` endpoint. This is live API permission evidence; the permission-denied UI itself is covered by the mocked browser regression. The OIDC case navigated through the visible local provider on port 8251, waited for the real `/api/v1/o/code` browser callback, verified “Smoke SSO User” and accessible data, signed out, and re-entered SSO successfully with stale-cookie handling. This validates the configured local mock protocol round trip, not Pocket ID or another real provider. The mock uses discovery, JWKS and RS256 ID tokens; it is a loopback fixture, not a production identity service.

The provider-free backend case separately passed **1/1 in 2.6s** after the same disposable server restarted without `P_OIDC_*` configuration:

```sh
npm_config_cache=/tmp/astra-item2-npm TMPDIR=/tmp/astra-item2-tmp \
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium \
PARSEABLE_LIVE_URL=http://127.0.0.1:8270 PARSEABLE_LIVE_NO_OIDC=true \
npm run test:live -- --grep 'unconfigured OIDC'
```

The full default check passed with **36 unit tests (5 files), 33 app browser tests, and 14 Storybook browser tests**. Formatting, TypeScript, production Vite build and Storybook build passed in the same command. App browser tests completed in 18.0s and Storybook tests in 5.7s, using system Chromium and the configured ten workers. Browser execution was serialized across agents.

```sh
npm_config_cache=/tmp/astra-item2-npm TMPDIR=/tmp/astra-item2-tmp \
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium npm run check
```

An initial check stopped with two test failures: an inexact Password locator also matched the newly named visibility button, and Chromium normalized zero-second `datetime-local` values so a fixture fill was rejected. Exact label matching and canonical minute-only fixture strings fixed those test assumptions. The complete command passed on rerun. Non-fatal Storybook chunk-size/deprecation warnings remain; there were no build or test failures in the final run.

## Reproduce the disposable live environment

The following values are public local fixture values, not deployment credentials. Reserve the listed loopback ports before starting processes. Stop the fixture processes afterward.

Build from the repository root. The successful session isolated Cargo/cache/temp output and used a snapshot of built assets so a concurrent frontend build could not delete Rust include files:

```sh
export PATH="$HOME/.cargo/bin:$PATH"
mkdir -p /tmp/astra-item2-assets /tmp/astra-item2-tmp
cp -a frontend/dist/. /tmp/astra-item2-assets/
CARGO_HOME=/tmp/astra-item2-cargo \
CARGO_TARGET_DIR=/tmp/astra-item2-target \
CARGO_PROFILE_DEV_DEBUG=0 CARGO_BUILD_JOBS=6 CARGO_INCREMENTAL=0 \
LOCAL_ASSETS_PATH=/tmp/astra-item2-assets TMPDIR=/tmp/astra-item2-tmp \
cargo build --locked --bin parseable
```

This session copied an available Cargo registry cache into the isolated Cargo home; a fresh environment may download dependencies. The initial build attempt hit a missing generated frontend asset while another build replaced `dist`; the stable snapshot resolved that build-input race without changing Rust.

Start the mock provider from `frontend`:

```sh
node e2e-live/fixtures/mock-oidc.mjs
```

Start the worktree-built backend from the repository root:

```sh
P_ADDR=127.0.0.1:8250 \
P_GRPC_PORT=8252 P_FLIGHT_PORT=8253 P_QUERY_GRPC_PORT=8254 \
P_USERNAME=frontend-smoke P_PASSWORD=local-smoke-password \
P_FS_DIR=/tmp/astra-item2-data/store \
P_STAGING_DIR=/tmp/astra-item2-data/staging \
P_SEND_ANONYMOUS_USAGE_DATA=false P_CHECK_UPDATE=false \
P_ORIGIN_URI=http://127.0.0.1:8270 \
P_ALLOW_ORIGINS=http://127.0.0.1:8260,http://127.0.0.1:8270 \
P_OIDC_CLIENT_ID=frontend-smoke P_OIDC_CLIENT_SECRET=local-fixture-secret \
P_OIDC_ISSUER=http://127.0.0.1:8251 \
RUST_LOG=info TMPDIR=/tmp/astra-item2-tmp \
/tmp/astra-item2-target/debug/parseable local-store
```

Start Vite from `frontend`:

```sh
PARSEABLE_PROXY_TARGET=http://127.0.0.1:8250 npm run dev -- --port 8270
```

The opt-in suite performs its own synthetic ingestion. `PARSEABLE_LIVE_USERNAME`, `PARSEABLE_LIVE_PASSWORD` and `PARSEABLE_LIVE_DATASET` override its defaults. It writes the dataset and, in the OIDC test, a reader role named `frontend-smoke-reader`. A separate invocation with no `PARSEABLE_LIVE_URL` completed successfully with **all 8 tests skipped**, confirming opt-in behavior without the suite ingestion hook. `npm run check` does not run live tests.

For the original UI reference, `node e2e-live/fixtures/prism-proxy.mjs` serves the read-only cached v3.2.4 distribution on port 8260 with SPA fallback and `/api` proxying to 8250. Native authentication was used for this reference because the mock provider callback is configured for port 8270. See [parity evidence](prism-parity.md) for screenshots, measurements and limits.

For the missing-provider case, stop the disposable backend and restart it without the three `P_OIDC_*` variables. Use `PARSEABLE_LIVE_NO_OIDC=true` and the targeted missing-provider test. The targeted case passed as recorded above.

## Component and interaction review

Primitives own appearance and native/Radix semantics. Feature owners handle query/session state; table/chart presentation does not fetch data. Native controls expose labels; icon buttons have accessible names. Dialogs retain focus containment, Escape dismissal and opener focus restoration. Stable atlas hooks identify feature boundaries, while generated IDs remain accessibility relationships.

The shell does not expose dead enterprise navigation. Production sample mode is gated at build time. Authentication errors cannot be converted into demo success; permission denial is separate. Identity display prefers the server's user endpoint, with display-only cookie hints when the profile endpoint is unavailable; 401 and cancellation are never treated as a profile fallback. A stream-list probe still checks the session on local-content routes. Backend authorization remains authoritative. Login and logout navigate through the existing backend protocol and do not import the separate OIDC authorization changes from the reference deployment.

Recovered hooks include `#main-section`, `data-sidebar`, `data-field-node`, `lmt-sidebar-toggle`, filter-pill hooks, `data-dialog-confirm` and stable `data-tile-id`. New CSS and component names are implementation-owned. Pixel parity is not established simply by retaining hooks or passing accessibility tests.

## Remaining validation limits

Production demo gating passed in a separate Chromium script against production bundles served at ports 8271 (`VITE_ENABLE_DEMO=false`) and 8272 (`VITE_ENABLE_DEMO=true`). The disabled build ignored a preexisting `parseable-mode=demo`, returned missing-session Logs to login, exposed no demo button and still rendered `/components`. The enabled build offered explicit demo entry and retained the selected demo workspace after reload. [Recorded gate assertions](parity-screenshots/production-demo-gate.json) contain the outcomes. These bundles were built immediately before the final live-SQL initial-text adjustment, which does not affect the gate.

The gate builds used `VITE_ENABLE_DEMO=false` or `true`, `npm_config_cache=/tmp/astra-item2-npm`, `TMPDIR=/tmp/astra-item2-tmp`, and `npx vite build --outDir /tmp/astra-item2-production-no-demo` or `/tmp/astra-item2-production-demo`. Final source also passed the default production build in `npm run check`. Final screenshots are linked from [prism-parity.md](prism-parity.md).

Cross-browser behavior, production deployment, real-provider interoperability, provider membership/refresh revocation, complete accessibility conformance and every original Prism interaction are not covered. The 2026-10-07 baseline used browser-local dashboards. Subsequent dated sections record Team, Metrics, Alerts and server-backed Dashboards; saved views, traces and remaining feature areas are still outside scope. Wide-schema virtualization, arbitrary timezones and exact pixel equality remain parity gaps.

## Files and test coverage added in this iteration

| Area                        | Principal files                                                                                                                                                                                                                   | Change                                                                                                                                                                |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authentication and shell    | `src/app/{App,AppProvider,Sidebar,ConnectionDialog,LoginPage,LoginForm}.tsx`, `src/lib/{auth,client,config,demo,types}.ts`, `src/styles/auth-shell.css`                                                                           | Standalone login, safe SSO/document navigation, missing-provider recovery, session/identity handling, production demo gate and measured shell layout                  |
| Logs and shared explorer    | `src/features/logs/{LogsPage,FieldSidebar,FilterBar}.tsx`, `src/components/explorer/{ColumnPicker,DataTable,TimeRangePicker,RecordSheet,LogHistogram,QueryState}.tsx`, `src/components/explorer/timestamp.ts`, `src/lib/query.ts` | Compact summary results, columns/sort/wrap/export, edit/clear filters, absolute UTC ranges, event actions, explicit auth states and timezone-less backend UTC parsing |
| Existing route presentation | `src/features/sql/SqlPage.tsx`, `src/features/datasets/DatasetsPage.tsx`, `src/features/dashboards/DashboardsPage.tsx`, `src/styles/global.css`                                                                                   | SQL explorer/empty live editor/results controls, inventory table and historical browser-local dashboard layout refinements                                            |
| Unit coverage               | `src/lib/{auth,client,query}.test.ts`, `src/components/explorer/timestamp.test.ts`                                                                                                                                                | Safe return paths, cookies/identity/auth request contracts, query bounds and backend timestamp handling; existing dashboard storage coverage retained                 |
| App browser coverage        | `e2e/auth.spec.ts`, `e2e/explorer-parity.spec.ts`, `e2e/app.spec.ts`, `playwright.config.ts`                                                                                                                                      | Six auth and five explorer parity cases added; existing flows updated and regression coverage retained                                                                |
| Real-server coverage        | `e2e-live/server.spec.ts`, `playwright.live.config.ts`, `e2e-live/fixtures/{mock-oidc,prism-proxy}.mjs`, `package.json`                                                                                                           | Opt-in live tests, protocol fixture, original-asset proxy and `test:live`; excluded from default check                                                                |
| Team administration         | `src/features/team/*`, `src/components/ui/{Pagination,TypedConfirmDialog}.tsx`, `src/lib/{client,demo,teamContract,types}.ts`, `e2e/team.spec.ts`, `e2e-live/team.spec.ts`                                                        | 26 demo/mocked browser cases, client/demo/helper unit tests and six self-cleaning real-server cases                                                                   |
| Documentation/evidence      | `README.md`, `docs/{api-contracts,component-map,component-design-review,prism-parity,validation-review}.md`, `docs/parity-screenshots/`, `docs/wiki-drafts/prism-frontend-parity.md`                                              | Current contracts, actionable comparison, completed checks, final screenshots and local unpublished wiki draft                                                        |

The README build/embed section and unrelated packaging/Rust/Docker/CI changes belong to concurrent work and were preserved. The final full check preceded only documentation and live-suite assertion adjustments; application source was unchanged afterward. No Rust authorization changes, external publishing, commits or deployed-service changes were made for this frontend iteration.

A final review run initially assumed the restricted reader would receive HTTP 403 for another stream's schema. The real backend returned HTTP 200 instead. This is metadata visibility, not proof of event-query access, and the frontend does not change existing backend privileges. The acceptance assertion was corrected to use an administrative resource rather than treating globally visible metadata as a denial boundary. After this correction the final live run passed 7 tests with the one expected missing-provider skip, as recorded above.

## Alerts cleanup validation (2026-10-10)

Results from `fix/frontend-alerts-cleanup`, run in Chromium (`/usr/bin/chromium`) under the shared Playwright lock.

- `npm run format` then `npm run check` passed: format check, `tsc` build, 819 unit tests in 24 files, 173 browser tests and 42 Storybook tests.
- The Alerts 390px no-overflow test now also asserts, for the Alerts list and Targets tables, that the row actions button is visible, inside the 390px viewport with the table scrolled to its left edge, not covered, and opens its menu without scrolling. Before the sticky Actions column was kept on mobile, the same assertions failed (button at x = 535px).
- Pristine Alert and Target forms show no errors, except for a non-empty invalid value the Alert form opens with (a handoff, duplicate or saved alert). Blurring a field or attempting to submit reveals them, focuses the first enabled invalid control (including the target checkboxes behind a targets error) and keeps `aria-invalid`/`aria-describedby` in step; Create and Save stay enabled for validation errors and are disabled only while saving or loading.
- Numbers share `formatChartValue` (trailing zeros dropped from the mantissa, never the exponent): preview table, PromQL runtime instances, chart axis, tooltip and threshold labels. The Metrics results table delegates to it, so `2.50` now reads `2.5` there too. The configured Threshold on the alert detail and runtime cards shows the exact stored number.
- The PromQL editor story flake was a click on a completion list that CodeMirror had disabled while re-querying. It is fixed in the test by waiting for the live list. `story-tests/metrics-components.spec.ts` passed 720 of 720 with `--repeat-each=30 --workers=4`, and the editor tests passed 280 of 280 with `--repeat-each=40 --workers=8` under about 10 busy-loop CPU burners.
- The "detail, preview and target sheet have padded cards..." flake (`.uplot` lost its `data-retained` marker after Unmute, 4 to 5 of 15 runs, also on `origin/main`) was a test race, not a product bug. The runtime chart's window ends at the current second and moves forward when the alert reloads, which rebuilds the plot with the new range. In 12 serial runs the marker was lost exactly when the mocked `query_range` saw two different `end` values. The test now pins the clock with `page.clock.setFixedTime`, and passed 30 of 30 with `--repeat-each=30 --workers=4`.
- `InlineError` was identical in Alerts and Team (only the attribute order differed) and now lives in `src/components/ui/InlineError.tsx`, exported from the UI index.
- The final `npm run check` passed with 819 unit tests, 173 browser tests and 42 Storybook tests. An earlier full run had one unrelated failure in `e2e/app.spec.ts` "native login switches from demo to live" while the machine was at load average 36. That test then passed 20 of 20 in isolation and the check passed on rerun.
