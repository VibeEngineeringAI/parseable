# Keystone browser validation

Run the focused Storybook interaction suite from `frontend`:

```sh
npm run build-storybook
npx playwright test -c playwright.keystone.config.ts
```

Set `TMPDIR` to a directory with free space if the default temporary directory is small.

Build Storybook first: the config serves the existing `storybook-static` directory and does not
build it. It starts its own server on `127.0.0.1:6046` (or `KEYSTONE_STORY_PORT`) with
`--strictPort` and no server reuse, so the run fails rather than silently testing another build
already listening there. Live source edits or a simultaneous build therefore cannot reload a
measured interaction. `KEYSTONE_STORY_URL` is only for explicitly testing a Storybook server you
started yourself; when it is set, no server is started. Chromium must be installed in the normal
Playwright cache, or supplied with `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`.

### Ports for the CI suites

| Variable              | Suite                           | Behavior                                                                                                                                          |
| --------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `KEYSTONE_STORY_PORT` | `playwright.keystone.config.ts` | Default 6046; strict port, never reuses a server                                                                                                  |
| `KEYSTONE_STORY_URL`  | `playwright.keystone.config.ts` | Explicit opt-in to an external server; nothing is started                                                                                         |
| `UI_TEST_PORT`        | `npm run test:ui`               | When set, starts this checkout's dev server on that port with `--strictPort` and never reuses one. Unset: port 5173, reused outside CI            |
| `STORYBOOK_TEST_PORT` | `npm run test:stories`          | Default 6006; strict port. Outside CI an existing server on that port is reused, so make sure it serves this checkout's build or pick a free port |

End-to-end expectations derive URLs from the configured base URL, so `test:ui` passes on a
non-default `UI_TEST_PORT`.

## Artifacts

Every test retains a screenshot, video, trace, and fixture request log in a run folder under
`test-results/keystone/<run-id>`. Set `KEYSTONE_RUN_ID` to name that folder; otherwise it uses a
timestamp. Separate runs keep earlier artifacts. The HTML report is in `playwright-report/keystone`.
Open a trace with `npx playwright show-trace path/to/trace.zip`.

Both folders are ignored by git and are **not part of this change**. To inspect equivalent
artifacts, rerun the suite with your own `KEYSTONE_RUN_ID`, or run a single file or test with
`--grep`. Recorded demos use labeled mock inference and are shared with reviewers separately.

## What the suite gates

Interaction checks gate behavior: geometry edits must not send semantic commands, streaming must
preserve the viewport, branch requests must use the pinned direct parent export, and wider scope
must require explicit approval. Reader navigation, mobile layout, keyboard actions, and reduced
motion are checked in the browser.

The 100-node tree exercise records animation-frame intervals while panning, zooming, moving a card,
and receiving streamed updates. Measurements at normal speed and Chromium's 4× CPU throttle are
advisory: frame interval p95 and counts over 50 ms depend on the browser, hardware, and test
instrumentation. The graph, request, and viewport assertions are deterministic gates.

## Foundation checks

The foundation suite covers inspector request cancellation (moving from one node to another
cancels the delayed evidence load, prevents cross-node source painting, and lets the cancelled
load be retried) and narrow-screen behavior: the reader is the default, controls are at least 44
pixels, and switching to Canvas overview disables card drag, resize, and layout buttons. Keyboard
arrows and a pointer drag leave geometry unchanged and send no layout PATCH, while pan and zoom
still work.

The foundation performance scenario, recorded before the explicit formatting preview was added,
used the actual 100-node, 99-edge tree, retained all cards in the DOM, and delivered 200 answer
chunks plus a status and terminal event. Every event preserved the viewport, selected node, and
focused node and sent no additional fixture requests. Trace and video recording were enabled
during timing.

| CPU throttle | Frame intervals |     p95 | Intervals over 50 ms |  Maximum |
| ------------ | --------------: | ------: | -------------------: | -------: |
| 1×           |           1,117 | 16.7 ms |                    0 |  33.3 ms |
| 4×           |           2,235 | 50.0 ms |                  103 | 133.2 ms |

Each performance test writes `frame-timing.json` (every frame interval), `hundred-nodes-1x.png` or
`hundred-nodes-4x.png`, `trace.zip`, `video.webm` and `fixture-requests.json` into its test folder.

The focused timing tests allow three minutes so that frame speed remains advisory; an earlier 4×
run against a live development server exceeded the original 60-second timeout, and a Storybook
reload during a build interrupted another. Serving a frozen build prevents both.

## Auto format

The Auto format cases verify all pairwise card intersections, retained width and height, compact
bounding boxes and shorter edge endpoint distances for 10 and 100 cards. They gate unchanged
camera, selection, focus, semantic revision, and answer data. Formatting twice produces identical
geometry. A preview remains local beyond the autosave debounce; Save sends one layout PATCH, and
Undo restores exact geometry. Overlapping pins remain fixed with a visible conflict notice.
Streamed answer events change neither the original sprawl nor the formatted preview. A queued move
autosave is suspended during review and resumes with only its original move on Undo. Held
transport writes verify that in-flight saves block conflicting edits; a later manual move
invalidates the saved formatting Undo.

The instrumented action-to-settled-geometry timings below are advisory. They include the browser
action, two animation frames, DOM snapshot, and trace recording. Edge extent is the total
horizontal and vertical distance between parent source and child target endpoints, rather than a
measurement of rendered Bézier paths.

| Cards | Action to settled geometry | Bounding-box area before → after | Edge endpoint extent before → after |
| ----- | -------------------------: | -------------------------------: | ----------------------------------: |
| 10    |                      90 ms |           44,044,000 → 4,477,244 |                      40,775 → 3,374 |
| 100   |                     214 ms |       1,129,765,910 → 74,661,951 |                2,229,315 → 87,108.6 |

The Save/Undo demo test writes `auto-format-before.png`, `auto-format-after.png`, `video.webm`,
`trace.zip` and `auto-format-metrics.json` (exact initial and formatted geometry and timing). The
demo pauses before and after formatting, verifies that format itself preserves the camera, then
invokes the explicit Fit View control to show the compact overview before saving. The 100-card
test writes its own `auto-format-metrics.json`.

## Full-page integration

The full-page cases use the actual `KeystoneFullPage`, workspace, new-investigation form, run
follower, composer, inspector, and collapse controls against an explicitly isolated story
transport. This transport stores fixture investigations, layouts, selected-source metadata, and
mock run events in per-story browser `localStorage`; a persisted router path reopens the same item
after reload. It does not contact the native API, a provider, or a query service. The banner and
every generated answer explicitly identify scripted mock inference. Native adapter and backend
integration validation are separate from these browser fixture checks.

The full-page story IDs are:

- `keystone-full-page--durable-mock`: list, create, reopen, and explicit mock Run/Cancel.
- `keystone-full-page--collapse-persistence`: collapsed root beside another card, making expansion
  collisions visible without moving either card automatically.
- `keystone-full-page--execution-unavailable`: durable saved work and drafts remain usable while
  Run is explicitly gated.
- `keystone-full-page--mobile`: the same full-page flow in a mobile touch viewport.
- `keystone-full-page--provider-setup`: the optional administrator connection form.

The browser checks verify that listing, saving a root draft, reopening, and saving a child draft
never start inference. A 30-day selection freezes exact UTC bounds; the saved scope remains
unchanged after reload. Clicking Run starts precisely one mock run, and each scripted result
preserves the canvas viewport and focused node. Cancel retains the partial answer and completed
source on reopen without restarting the run; only the explicit Retry action starts a distinct
second run, with a new idempotency key and the same approved scope. Parent sources are unchecked
by default; a branch passes either no sources or exactly the one source explicitly selected,
retains the direct-parent version and server export hash, and inherits the same 30-day scope.

Collapse restores the exact expanded height and persists that expanded height with the collapsed
flag, rather than saving the 46-pixel header height. Expansion reports the card it covers and
leaves other geometry and semantic graph unchanged. Auto format uses the drawn collapsed sizes,
keeps the collapsed flag through explicit Save, and Undo restores the exact previous geometry.
Mobile keyboard checks confirm the default reader, local collapse in the read-only canvas
overview, no layout write or implicit inference, and no horizontal overflow. Both the mobile index
and the mobile collapsed canvas pass WCAG 2 A/AA and WCAG 2.1 AA axe checks.

The provider-setup story's synthetic save handler never stores or logs the entered value,
retaining only `{ "action": "credential_saved" }` as an action marker. The browser test uses
public, non-secret surrogate strings with surrounding whitespace, verifies trimming before
submission and that the password input is cleared after success and failure, checks no surrogate
value appears in local storage, fixture snapshots, request logs, or body text, and confirms that
saving a credential never runs a question. The failure message contains no entered value. The
expanded setup form also passes the axe audit. Actual native credential HTTP behavior is tested
separately in Rust; no real provider credential is entered in the browser fixture.

## Run links, progress and follow-up questions

`keystone-run-progress.spec.ts` covers queued-to-completed phases, run deep links and reload,
failure without implicit retry, exact direct-parent follow-up requests, terminal recovery after
disconnect, reconnect without new inference, honest stale/unknown links, and mobile accessibility.
Branch tests assert immediate focus on the question textarea; cancelling restores focus to the
quick follow-up control. Viewport/focus stability and no inference requests during
navigation/replay are deterministic gates.

Advisory timings on the 100-node, 99-edge tree from the latest recorded performance run:

| CPU throttle | Frames | p95 frame interval | Frames over 50 ms |  Maximum |
| ------------ | -----: | -----------------: | ----------------: | -------: |
| 1x           |  1,172 |            16.8 ms |                 0 |  33.4 ms |
| 4x           |  2,313 |            66.7 ms |        187 (8.1%) | 199.9 ms |

These machine-specific observations are not a universal smoothness guarantee.

## Readiness, denial and classic links

`keystone-readiness.spec.ts` covers denied, storage-unavailable, degraded, unsupported,
session-expired (401) and forbidden (403) pages, each with exactly one capability read and no
dataset request, plus a ready investigation link where datasets are listed once, after
capabilities. In `test:ui`, `e2e/native-regressions.spec.ts` serves plain-text 403 responses the
way the authentication middleware does and checks the denial, the classic links under `/next`
and that no dataset lookups happen; `e2e/classic-links.spec.ts` checks that the root-mounted page
shows the storage explanation and no classic link.

## Recorded results

Under CI, `npm run test:stories` runs the Keystone specs as the `keystone` project of
`playwright.storybook.config.ts`, at the same viewport and timeout as the focused config above
but without retained artifacts. In the final frontend validation the full `npm run check` passed
inside the pinned CI Playwright container; `test:stories` passed **293/293**, including the
screenshot specs and all **60** Keystone cases. Results are in
[validation status](keystone-foundations.md#validation-status).

Screenshot comparisons are only meaningful inside the CI container. On a developer machine the
screenshot specs may fail because of local font and rendering differences; that is not a
regression signal, and baselines must not be refreshed from such a run.
