import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import { Badge, Button, Pagination } from '../../components/ui';
import { formatTimestamp } from '../../components/explorer/timezone';
import type { TraceListRecord, TraceListResponse, TraceSortBy } from '../../lib/types';
import { durationMs, formatDuration, TRACE_PAGE_SIZE } from './helpers';

const sorts = [
  { title: 'Started (UTC)', ascending: 'leastRecent', descending: 'mostRecent' },
  { title: 'Duration', ascending: 'shortestFirst', descending: 'longestFirst' },
  { title: 'Spans', ascending: 'leastSpans', descending: 'mostSpans' },
] as const;

export function TraceTable({
  data,
  sort,
  onSort,
  onPage,
  onSelect,
  noun = 'traces',
}: {
  data: TraceListResponse;
  sort: TraceSortBy;
  onSort: (sort: TraceSortBy) => void;
  onPage: (page: number) => void;
  onSelect: (row: TraceListRecord) => void;
  noun?: string;
}) {
  function header(index: number) {
    const column = sorts[index];
    const direction =
      sort === column.ascending ? 'ascending' : sort === column.descending ? 'descending' : 'none';
    const Icon =
      direction === 'ascending' ? ArrowUp : direction === 'descending' ? ArrowDown : ArrowUpDown;
    return (
      <th scope="col" aria-sort={direction}>
        <button
          className="column-sort"
          aria-label={`Sort ${column.title}`}
          onClick={() => onSort(direction === 'descending' ? column.ascending : column.descending)}
        >
          {column.title}
          <Icon size={13} aria-hidden="true" />
        </button>
      </th>
    );
  }
  return (
    <div className="results-table traces-table" data-testid="trace-table">
      <div className="table-scroll" tabIndex={0} role="region" aria-label="Trace results">
        <table>
          <caption className="sr-only">
            {noun === 'traces' ? 'Root traces' : noun} in the selected dataset and time range
          </caption>
          <thead>
            <tr>
              <th scope="col">Trace / operation</th>
              <th scope="col">Service</th>
              {header(0)}
              {header(1)}
              {header(2)}
              <th scope="col">Errors</th>
            </tr>
          </thead>
          <tbody>
            {data.records.map((row, index) => (
              <tr key={`${row.span_trace_id}:${row.span_span_id}:${index}`}>
                <td>
                  <Button
                    variant="ghost"
                    className="traces-open-trace"
                    aria-label={`Open trace ${row.span_trace_id}, ${row.span_name}`}
                    onClick={() => onSelect(row)}
                  >
                    <span className="traces-operation">{row.span_name || 'Unnamed span'}</span>
                    <code title={row.span_trace_id}>{row.span_trace_id}</code>
                  </Button>
                </td>
                <td>
                  <span className="traces-service">
                    <i aria-hidden="true" />
                    {row['service.name']}
                  </span>
                </td>
                <td className="traces-timestamp">
                  <time
                    dateTime={row.span_start_time_unix_nano}
                    title={row.span_start_time_unix_nano}
                  >
                    {formatTimestamp(row.span_start_time_unix_nano, 'UTC')}
                  </time>
                </td>
                <td className="mono">{formatDuration(durationMs(row.span_duration_ns))}</td>
                <td>{row.total_span_count.toLocaleString()}</td>
                <td>
                  {row.error_count > 0 ? (
                    <Badge tone="danger">
                      {row.error_count.toLocaleString()}{' '}
                      {row.error_count === 1 ? 'error' : 'errors'}
                    </Badge>
                  ) : (
                    <span className="muted">0</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Pagination
        page={Math.floor(data.offset / TRACE_PAGE_SIZE)}
        total={data.count}
        noun={noun}
        onPageChange={onPage}
      />
    </div>
  );
}
