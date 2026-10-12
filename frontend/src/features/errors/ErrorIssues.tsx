import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ArrowDown, ArrowUpDown, ArrowUpRight, ChevronLeft, ChevronRight } from 'lucide-react';
import { useApp } from '../../app/AppProvider';
import { useAsync } from '../../hooks/useAsync';
import { Button, EmptyState, Sheet } from '../../components/ui';
import { QueryState } from '../../components/explorer/QueryState';
import { formatTimestamp } from '../../components/explorer/timezone';
import { TimeSeriesChart } from '../../components/charts/TimeSeriesChart';
import {
  buildErrorExplorerSql,
  ERROR_PAGE_SIZE,
  loadErrorIssues,
  loadErrorOccurrences,
  loadErrorSeries,
  loadErrorSummary,
  type ErrorBounds,
  type ErrorBucket,
  type ErrorIssue,
  type ErrorSchema,
  type ErrorSort,
} from '../../lib/errorAnalytics';
import { apmTransportBounds } from '../../lib/apm';

type Props = { dataset: string; schema: ErrorSchema; bounds: ErrorBounds };

/** Source-specific wording; a log record and an error span are different things. */
export function occurrenceNoun(schema: ErrorSchema, count = 2): string {
  const plural = count !== 1;
  return schema.source === 'traces'
    ? plural
      ? 'error spans'
      : 'error span'
    : plural
      ? 'error log records'
      : 'error log record';
}

function utc(value: string | null): string {
  return value ? `${formatTimestamp(value, 'UTC')} UTC` : '—';
}

function minutes(bounds: ErrorBounds): number {
  return (Date.parse(bounds.endTime) - Date.parse(bounds.startTime)) / 60_000;
}

function perMinute(count: number, bounds: ErrorBounds): string {
  const rate = count / minutes(bounds);
  return rate > 0 && rate < 0.01
    ? '<0.01'
    : rate.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

/** A missing value is shown as a placeholder that cannot be mistaken for a literal value. */
function Value({ value, missing }: { value: string | null; missing: string }) {
  return value === null ? <span className="errors-missing">{missing}</span> : <>{value}</>;
}

function fieldList(fields: string[]): string {
  return fields.length ? fields.join(', ') : 'none in this dataset';
}

export function ErrorCountingNote({ schema }: { schema: ErrorSchema }) {
  const severity = [
    schema.severity.text.length
      ? `${schema.severity.text.join(' or ')} is an error level such as error, fatal or critical`
      : '',
    schema.severity.number.length
      ? `${schema.severity.number.join(' or ')} is between 17 and 24 (OpenTelemetry error and fatal)`
      : '',
    schema.severity.text.includes('level') ? 'level is 50 or 60 (Pino/Bunyan error and fatal)' : '',
  ].filter(Boolean);
  return (
    <details className="errors-note">
      <summary>How errors are counted and grouped</summary>
      <p>
        {schema.source === 'traces'
          ? 'Each span with error status counts once, even if the same span was received more than once.'
          : `Each log record counts once when ${severity.join(', or when ')}.`}{' '}
        Times use{' '}
        {schema.timeColumn === 'p_timestamp' ? 'ingestion time' : `the ${schema.timeColumn} field`}.
      </p>
      <p>
        Issues group occurrences that have exactly the same service, error type and message.
        Messages that differ in any way, such as a request ID or number, are separate issues.
      </p>
      {schema.exception.type.length + schema.exception.message.length > 0 && (
        <p>Exception details recorded on a span take priority over its status message.</p>
      )}
      <dl className="errors-fields">
        <dt>Service</dt>
        <dd>{fieldList(schema.service)}</dd>
        <dt>Error type</dt>
        <dd>{fieldList([...schema.exception.type, ...schema.errorType])}</dd>
        <dt>Message</dt>
        <dd>{fieldList([...schema.exception.message, ...schema.message])}</dd>
      </dl>
    </details>
  );
}

function FrequencyChart({
  title,
  buckets,
  bounds,
  label,
}: {
  title: string;
  buckets: ErrorBucket[];
  bounds: ErrorBounds;
  label: string;
}) {
  return (
    <TimeSeriesChart
      title={title}
      timestamps={buckets.map((bucket) => Date.parse(bucket.bucket) / 1000)}
      series={[{ id: 'occurrences', label, values: buckets.map((b) => b.occurrences) }]}
      xRange={[Date.parse(bounds.startTime) / 1000, Date.parse(bounds.endTime) / 1000]}
      kind="bar"
      height={200}
      timeZone="UTC"
      showSeriesCount={false}
      formatValue={(value) => value.toLocaleString()}
    />
  );
}

function Pager({
  offset,
  count,
  total,
  hasMore,
  noun,
  onOffset,
}: {
  offset: number;
  count: number;
  total?: number;
  hasMore: boolean;
  noun: string;
  onOffset: (offset: number) => void;
}) {
  if (!count && !offset) return null;
  const page = Math.floor(offset / ERROR_PAGE_SIZE) + 1;
  return (
    <div className="table-footer">
      <span role="status">
        Showing {offset + 1}–{offset + count}
        {total !== undefined ? ` of ${total.toLocaleString()}` : ''} {noun}
      </span>
      <div className="inline">
        <Button
          size="icon"
          variant="ghost"
          aria-label="Previous page"
          disabled={offset === 0}
          onClick={() => onOffset(Math.max(0, offset - ERROR_PAGE_SIZE))}
        >
          <ChevronLeft size={16} aria-hidden="true" />
        </Button>
        <span>
          Page {page}
          {total !== undefined ? ` of ${Math.max(1, Math.ceil(total / ERROR_PAGE_SIZE))}` : ''}
        </span>
        <Button
          size="icon"
          variant="ghost"
          aria-label="Next page"
          disabled={!hasMore}
          onClick={() => onOffset(offset + ERROR_PAGE_SIZE)}
        >
          <ChevronRight size={16} aria-hidden="true" />
        </Button>
      </div>
    </div>
  );
}

const sortColumns: { sort: ErrorSort; title: string }[] = [
  { sort: 'frequency', title: 'Occurrences' },
  { sort: 'latest', title: 'Last seen (UTC)' },
  { sort: 'first', title: 'First seen (UTC)' },
];

function SortHeader({
  column,
  sort,
  onSort,
}: {
  column: (typeof sortColumns)[number];
  sort: ErrorSort;
  onSort: (sort: ErrorSort) => void;
}) {
  const active = sort === column.sort;
  const Icon = active ? ArrowDown : ArrowUpDown;
  return (
    <th scope="col" aria-sort={active ? 'descending' : 'none'}>
      <button
        className="column-sort"
        aria-label={`Sort by ${column.title}`}
        onClick={() => onSort(column.sort)}
      >
        {column.title}
        <Icon size={13} aria-hidden="true" />
      </button>
    </th>
  );
}

function Stat({ label, value, note }: { label: string; value: ReactNode; note?: ReactNode }) {
  return (
    <div className="errors-stat">
      <dt>{label}</dt>
      <dd>{value}</dd>
      {note && <dd className="errors-stat-note">{note}</dd>}
    </div>
  );
}

/** Grouped error issues for one dataset and one captured time range. The parent
 * remounts this view when the dataset, range or refresh changes, resetting paging,
 * sort order and the selected issue together. */
export function ErrorIssues({ dataset, schema, bounds }: Props) {
  const { client } = useApp();
  const [sort, setSort] = useState<ErrorSort>('frequency');
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<ErrorIssue>();
  const options = { dataset, schema, bounds };
  const summary = useAsync(
    useCallback(
      (signal) => loadErrorSummary(client, { dataset, schema, bounds }, signal),
      [client, dataset, schema, bounds],
    ),
  );
  const series = useAsync(
    useCallback(
      (signal) => loadErrorSeries(client, { dataset, schema, bounds }, signal),
      [client, dataset, schema, bounds],
    ),
  );
  const issues = useAsync(
    useCallback(
      (signal) => loadErrorIssues(client, { dataset, schema, bounds, sort, offset }, signal),
      [client, dataset, schema, bounds, sort, offset],
    ),
  );
  const noun = occurrenceNoun(schema);
  const total = summary.data?.issues;
  return (
    <div className="errors-issues">
      <ErrorCountingNote schema={schema} />
      <QueryState loading={summary.loading} error={summary.error} retry={summary.reload} />
      {summary.data && (
        <dl className="errors-stat-grid" aria-label="Error summary">
          <Stat
            label={schema.source === 'traces' ? 'Error spans' : 'Error log records'}
            value={summary.data.occurrences.toLocaleString()}
            note={`${perMinute(summary.data.occurrences, bounds)} per minute`}
          />
          <Stat
            label="Issues"
            value={summary.data.issues.toLocaleString()}
            note="Exact service, error type and message"
          />
          <Stat label="First seen" value={utc(summary.data.firstSeen)} />
          <Stat label="Last seen" value={utc(summary.data.lastSeen)} />
        </dl>
      )}
      <section className="errors-panel" aria-label="Error frequency">
        <QueryState loading={series.loading} error={series.error} retry={series.reload} />
        {series.data && (
          <FrequencyChart
            title={`${schema.source === 'traces' ? 'Error spans' : 'Error log records'} over time`}
            buckets={series.data}
            bounds={bounds}
            label="Occurrences"
          />
        )}
      </section>
      <section className="errors-panel" aria-labelledby="errors-issues-heading">
        <h2 id="errors-issues-heading">Issues</h2>
        <QueryState loading={issues.loading} error={issues.error} retry={issues.reload} />
        {issues.data &&
          (issues.data.rows.length ? (
            <div className="results-table" data-testid="error-issue-table">
              <div className="table-scroll" tabIndex={0} role="region" aria-label="Error issues">
                <table>
                  <caption className="sr-only">
                    Error issues in {dataset}, grouped by exact service, error type and message
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">Issue</th>
                      <th scope="col">Service</th>
                      {sortColumns.map((column) => (
                        <SortHeader
                          key={column.sort}
                          column={column}
                          sort={sort}
                          onSort={(value) => {
                            setOffset(0);
                            setSort(value);
                          }}
                        />
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {issues.data.rows.map((issue) => (
                      <tr key={issue.id}>
                        <td>
                          <button
                            className="errors-issue-button"
                            aria-haspopup="dialog"
                            onClick={() => setSelected(issue)}
                          >
                            <span className="errors-issue-message">
                              <Value value={issue.message} missing="No message" />
                            </span>
                            <span className="errors-issue-type">
                              <Value value={issue.errorType} missing="No error type" />
                            </span>
                          </button>
                        </td>
                        <td>
                          <Value value={issue.service} missing="No service" />
                        </td>
                        <td className="errors-number">{issue.occurrences.toLocaleString()}</td>
                        <td>{utc(issue.lastSeen)}</td>
                        <td>{utc(issue.firstSeen)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Pager
                offset={issues.data.offset}
                count={issues.data.rows.length}
                total={total}
                hasMore={issues.data.hasMore}
                noun="issues"
                onOffset={setOffset}
              />
            </div>
          ) : offset ? (
            <EmptyState
              title="No more issues"
              description="This page is past the last issue in the selected time range."
              action={<Button onClick={() => setOffset(0)}>Back to first page</Button>}
            />
          ) : (
            <EmptyState
              title="No errors"
              description={`No ${noun} were found in ${dataset} in the selected time range.`}
            />
          ))}
      </section>
      {selected && (
        <ErrorIssueDetail {...options} issue={selected} onClose={() => setSelected(undefined)} />
      )}
    </div>
  );
}

function ErrorIssueDetail({
  dataset,
  schema,
  bounds,
  issue,
  onClose,
}: Props & { issue: ErrorIssue; onClose: () => void }) {
  const { client, mode } = useApp();
  const [offset, setOffset] = useState(0);
  // Queries and handoffs identify the issue only by its exact group key.
  const key = useMemo(
    () => ({ service: issue.service, errorType: issue.errorType, message: issue.message }),
    [issue],
  );
  const series = useAsync(
    useCallback(
      (signal) => loadErrorSeries(client, { dataset, schema, bounds, issue: key }, signal),
      [client, dataset, schema, bounds, key],
    ),
  );
  const occurrences = useAsync(
    useCallback(
      (signal) =>
        loadErrorOccurrences(client, { dataset, schema, bounds, issue: key, offset }, signal),
      [client, dataset, schema, bounds, key, offset],
    ),
  );
  const range = { start: bounds.startTime, end: bounds.endTime };
  const traceLink = (traceId: string) =>
    `/traces/explore/${encodeURIComponent(dataset)}?${new URLSearchParams({ traceId, ...range })}`;
  // The SQL keeps the exact range; the editor's request range is rounded down to
  // whole minutes by the server, so hand off the enclosing minute envelope.
  const envelope = apmTransportBounds(bounds);
  const explorerSql =
    schema.source === 'logs' ? buildErrorExplorerSql({ dataset, schema, bounds, issue: key }) : '';
  // The sample adapter needs its canonical query marker. Live users should see
  // readable SQL without duplicated issue metadata in the editor or URL.
  const editorSql =
    mode === 'demo' ? explorerSql : explorerSql.replace(/^\/\* parseable-errors:[^\n]+ \*\/\n/, '');
  const sqlLink =
    schema.source === 'logs'
      ? `/sql-editor?${new URLSearchParams({
          query: editorSql,
          start: envelope.startTime,
          end: envelope.endTime,
        })}`
      : '';
  const traces = schema.source === 'traces';
  return (
    <Sheet
      open
      onOpenChange={(open) => !open && onClose()}
      title={issue.message ?? 'No message'}
      description={`${issue.occurrences.toLocaleString()} ${occurrenceNoun(schema, issue.occurrences)} in the selected time range`}
      className="errors-sheet"
    >
      <dl className="errors-detail-fields">
        <dt>Service</dt>
        <dd>
          <Value value={issue.service} missing="No service" />
        </dd>
        <dt>Error type</dt>
        <dd>
          <Value value={issue.errorType} missing="No error type" />
        </dd>
        <dt>Message</dt>
        <dd className="errors-detail-message">
          <Value value={issue.message} missing="No message" />
        </dd>
        <dt>First seen</dt>
        <dd>{utc(issue.firstSeen)}</dd>
        <dt>Last seen</dt>
        <dd>{utc(issue.lastSeen)}</dd>
      </dl>
      {!traces && (
        <Link className="text-link" to={sqlLink}>
          Open these log records in the SQL editor <ArrowUpRight size={14} aria-hidden="true" />
        </Link>
      )}
      <section aria-label="Issue frequency">
        <QueryState loading={series.loading} error={series.error} retry={series.reload} />
        {series.data && (
          <FrequencyChart
            title="Occurrences over time"
            buckets={series.data}
            bounds={bounds}
            label="Occurrences"
          />
        )}
      </section>
      <section aria-labelledby="errors-occurrences-heading">
        <h3 id="errors-occurrences-heading">Occurrences</h3>
        <QueryState
          loading={occurrences.loading}
          error={occurrences.error}
          retry={occurrences.reload}
        />
        {occurrences.data &&
          (occurrences.data.rows.length ? (
            <div className="results-table" data-testid="error-occurrence-table">
              <div className="table-scroll">
                <table>
                  <caption className="sr-only">
                    Most recent {occurrenceNoun(schema)} for this issue
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">Time (UTC)</th>
                      {traces && <th scope="col">Operation</th>}
                      <th scope="col">Trace</th>
                    </tr>
                  </thead>
                  <tbody>
                    {occurrences.data.rows.map((row, index) => (
                      <tr key={`${row.time}:${row.traceId}:${row.spanId}:${index}`}>
                        <td>{formatTimestamp(row.time, 'UTC')}</td>
                        {traces && <td>{row.operation || 'Unnamed span'}</td>}
                        <td>
                          {row.traceId && traces ? (
                            <Link
                              className="text-link"
                              to={traceLink(row.traceId)}
                              aria-label={`Open trace ${row.traceId}`}
                            >
                              <code>{row.traceId}</code>
                            </Link>
                          ) : row.traceId ? (
                            <code>{row.traceId}</code>
                          ) : (
                            <span className="errors-missing">No trace</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Pager
                offset={occurrences.data.offset}
                count={occurrences.data.rows.length}
                total={issue.occurrences}
                hasMore={occurrences.data.hasMore}
                noun={occurrenceNoun(schema)}
                onOffset={setOffset}
              />
            </div>
          ) : (
            <EmptyState
              title="No occurrences"
              description="No occurrences of this issue remain in the selected time range."
            />
          ))}
      </section>
    </Sheet>
  );
}
