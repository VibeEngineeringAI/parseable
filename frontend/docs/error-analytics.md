# Errors: grouping, frequency, and regression tests

The Errors page queries the existing SQL API for grouped issues and frequency. It also retains the native OTLP error-span list. The [Mayfly implementation record](https://mayfly-celld.tail835e0d.ts.net/w/46ncdGypknzAj7dnRkJ8bQ?page=1983eae1-fba9-4616-9643-1de4e746162c) records the scope and validation evidence.

## What the counts mean

An issue is an exact match of service, error type, and message. Empty strings and missing values are treated as absent; absent values remain distinct from literal text such as `(unknown)`. Variable IDs or numbers in messages create separate issues. There is no fuzzy grouping, saved resolution state, assignment, or cross-dataset correlation.

For OTLP traces, an occurrence is a distinct error span. The query deduplicates expanded event/link rows and retries by service, trace ID, and span ID before aggregating. A span must have error status `2`; an exception event alone does not make a successful span an error. When rows disagree, type and message come together from one representative row. A populated exception event takes priority over direct span attributes; ties use type then message in ascending order, with absent values last. This keeps groups deterministic without inventing a type/message combination that never occurred. The occurrence timestamp remains the earliest row in the selected interval.

For logs, an occurrence is one stored record. Repeated identical logs remain separate occurrences. Recognized textual severity fields are checked case-insensitively for error/fatal equivalents. OTLP numeric severity must be an integer code from 17 through 24; numeric `level` supports the standard Pino/Bunyan error (50) and fatal (60) codes. Fractional codes do not match. Message text is not searched for the word “error” to classify a record. The derived `p_log_category` field is excluded because OTLP ingestion can infer it from body text when severity is unspecified. A dataset with only that category and no explicit severity field is unsupported. Schema inspection selects available service, type and message aliases; unsupported schemas have an explicit explanation and a Log explorer link.

Each view covers one dataset and one captured time interval. The dataset's configured time partition defines that interval. SQL applies `start <= timestamp < end` precisely, while the request envelope expands to minute boundaries for the server planner. Frequency buckets divide the selected interval into at most 48 equal elapsed-time intervals, including zero-count buckets. Summary totals and frequency are independent of the current issue page.

Issue and occurrence pages request one extra row to decide whether another page exists. Sorting happens on the server with deterministic group tie-breakers. Dataset/range changes and refresh discard obsolete requests and selections. Native trace links preserve the captured bounds. Log investigation opens SQL with the same classification and exact issue predicates, returning full stored records so stack traces and other fields remain available. Live handoffs start with readable SQL; only sample mode retains the internal query marker needed by its restricted evaluator. A log trace ID does not imply a compatible trace dataset.

## Code map

- `src/lib/errorAnalytics.ts`: schema interpretation, safely quoted SQL, strict result decoding, loaders and group identity.
- `src/lib/errorAnalyticsDemo.ts`: deterministic sample-data evaluation, restricted to exact queries rebuilt from their metadata.
- `src/features/errors/`: page orchestration, grouped issues, frequency and occurrence inspection.
- `src/lib/errorAnalytics.test.ts`: fast data-contract and sample-data regressions.
- `src/lib/errorAnalytics.live.test.ts`: opt-in generated SQL checks against a real Parseable server.
- `e2e/errors.spec.ts`: browser state, navigation, pagination and failure behavior. API responses use fixture records; these tests do not establish SQL engine compatibility.

## Running the tests

From `frontend`, install dependencies with `npm ci`, then run focused unit tests:

```sh
npx vitest run src/lib/errorAnalytics.test.ts
```

The real-server suite is deliberately opt-in. It creates uniquely named disposable JSON-log, OTLP-log and OTLP-trace datasets and removes those datasets afterward. Use an isolated development server and an account allowed to ingest, query, and delete these fixtures:

```sh
ERRORS_REFERENCE_URL=http://127.0.0.1:8450 \
ERRORS_REFERENCE_USERNAME=fixture \
ERRORS_REFERENCE_PASSWORD=fixture-throwaway \
npx vitest run src/lib/errorAnalytics.live.test.ts
```

The example credentials belong to the local disposable fixture server. Without `ERRORS_REFERENCE_URL`, the suite skips its live tests. It derives bounds from persisted timestamps and polls for readiness instead of assuming ingestion is immediately queryable. Assertions use explicit fixture counts: they check retries and event expansion, nonerror exclusion, severity aliases, escaped message values, NULL identity, more than one page of groups, and agreement between frequency and summary counts.

Browser tests use the repository's Playwright configuration:

```sh
npx playwright test e2e/errors.spec.ts e2e/operations.spec.ts --workers=1
```

Ensure the configured server serves this checkout. A pre-existing server on the default port can belong to another worktree. Production build/type checking and the complete frontend unit suite are `npm run build` and `npm test`.

The Errors stories cover trace and log issues, loading, empty, permission, query failure, unsupported schema and unavailable metadata states. After building Storybook, run `native-screens.spec.ts --grep operations-errors` with `playwright.storybook.config.ts`. Detail stories exercise paging, trace links, keyboard dismissal and focus restoration; the suite also runs axe and a narrow dark viewport. Follow the shared Playwright lock instructions in the frontend README on shared hosts.
