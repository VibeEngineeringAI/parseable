import { useState } from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronLeft, ChevronRight } from 'lucide-react';
import { Badge, Button, EmptyState } from '../ui';
import type { LogRecord } from '../../lib/types';
export function formatValue(value: unknown): string {
  if (value == null) return '—';
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}
export function exportRecords(rows: LogRecord[], format: 'json' | 'csv') {
  const fields = [...new Set(rows.flatMap(Object.keys))];
  // Prefix spreadsheet formulas in CSV so exported log text remains data.
  const csvCell = (value: unknown) => {
    let text = value == null ? '' : formatValue(value);
    if (/^[=+@\-\t\r]/.test(text)) text = `'${text}`;
    return `"${text.replaceAll('"', '""')}"`;
  };
  const content =
    format === 'json'
      ? JSON.stringify(rows, null, 2)
      : [
          fields.map(csvCell).join(','),
          ...rows.map((row) => fields.map((f) => csvCell(row[f])).join(',')),
        ].join('\r\n');
  const url = URL.createObjectURL(
    new Blob([content], {
      type: format === 'json' ? 'application/json' : 'text/csv;charset=utf-8',
    }),
  );
  const link = document.createElement('a');
  link.href = url;
  link.download = `query-results.${format}`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function DataTable({
  rows,
  columns,
  onSelect,
  caption = 'Query results',
  wrap = false,
  summary = false,
}: {
  rows: LogRecord[];
  columns?: string[];
  onSelect?: (row: LogRecord) => void;
  caption?: string;
  wrap?: boolean;
  summary?: boolean;
}) {
  const [page, setPage] = useState(0);
  const [sort, setSort] = useState<{ field: string; descending: boolean }>();
  const pageSize = 25;
  const effectivePage = Math.min(page, Math.max(0, Math.ceil(rows.length / pageSize) - 1));
  const fields = columns || [...new Set(rows.flatMap(Object.keys))];
  const ordered = sort
    ? [...rows].sort((a, b) => {
        const left = a[sort.field],
          right = b[sort.field];
        const result =
          typeof left === 'number' && typeof right === 'number'
            ? left - right
            : formatValue(left).localeCompare(formatValue(right), undefined, { numeric: true });
        return sort.descending ? -result : result;
      })
    : rows;
  if (!rows.length)
    return (
      <EmptyState
        title="No matching events"
        description="Try a wider time range or adjust your query."
      />
    );
  return (
    <div className={`results-table ${wrap ? 'rows-wrapped' : ''}`}>
      <div className="table-scroll">
        <table>
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr>
              {onSelect && (
                <th scope="col">
                  <span className="sr-only">Details</span>
                </th>
              )}
              {fields.map((field) => (
                <th
                  scope="col"
                  key={field}
                  aria-label={
                    field === 'p_timestamp'
                      ? summary
                        ? 'Ingestion Time (UTC)'
                        : 'Timestamp (UTC)'
                      : field
                  }
                  aria-sort={
                    sort?.field === field ? (sort.descending ? 'descending' : 'ascending') : 'none'
                  }
                >
                  <button
                    className="column-sort"
                    aria-label={`Sort ${field}`}
                    onClick={() => {
                      setSort({
                        field,
                        descending: sort?.field === field ? !sort.descending : false,
                      });
                      setPage(0);
                    }}
                  >
                    {field === 'p_timestamp'
                      ? summary
                        ? 'Ingestion Time (UTC)'
                        : 'Timestamp (UTC)'
                      : field}
                    {sort?.field === field ? (
                      sort.descending ? (
                        <ArrowDown size={12} />
                      ) : (
                        <ArrowUp size={12} />
                      )
                    ) : (
                      <ArrowUpDown size={12} />
                    )}
                  </button>
                </th>
              ))}
              {summary && <th scope="col">Data</th>}
            </tr>
          </thead>
          <tbody>
            {ordered
              .slice(effectivePage * pageSize, (effectivePage + 1) * pageSize)
              .map((row, index) => (
                <tr
                  key={effectivePage * pageSize + index}
                  data-index={effectivePage * pageSize + index}
                >
                  {onSelect && (
                    <td>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Open event ${effectivePage * pageSize + index + 1}`}
                        onClick={() => onSelect(row)}
                      >
                        <ChevronRight size={14} />
                      </Button>
                    </td>
                  )}
                  {fields.map((field) => (
                    <td
                      key={field}
                      className={field === 'message' ? 'message-cell' : 'mono'}
                      title={formatValue(row[field])}
                    >
                      {field === 'level' ? (
                        <Badge
                          tone={
                            String(row[field]).toLowerCase() === 'error'
                              ? 'danger'
                              : String(row[field]).toLowerCase() === 'warn'
                                ? 'warning'
                                : 'success'
                          }
                        >
                          {formatValue(row[field])}
                        </Badge>
                      ) : field === 'p_timestamp' ? (
                        formatValue(row[field]).replace('T', ' ').replace('Z', '')
                      ) : (
                        formatValue(row[field])
                      )}
                    </td>
                  ))}
                  {summary && (
                    <td className="mono log-data-cell">
                      {Object.entries(row)
                        .filter(([key]) => !fields.includes(key))
                        .map(([key, value]) => (
                          <span className="log-data-pair" key={key}>
                            <span className="log-data-key">{key}</span>=
                            <span>{formatValue(value)}</span>{' '}
                          </span>
                        ))}
                    </td>
                  )}
                </tr>
              ))}
          </tbody>
        </table>
      </div>
      <footer className="table-footer">
        <span>
          {rows.length.toLocaleString()} rows · {effectivePage * pageSize + 1}–
          {Math.min((effectivePage + 1) * pageSize, rows.length)}
        </span>
        <div className="inline">
          <Button
            variant="ghost"
            size="icon"
            aria-label="Previous page"
            disabled={effectivePage === 0}
            onClick={() => setPage(effectivePage - 1)}
          >
            <ChevronLeft size={15} />
          </Button>
          <span>
            Page {effectivePage + 1} of {Math.ceil(rows.length / pageSize)}
          </span>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Next page"
            disabled={(effectivePage + 1) * pageSize >= rows.length}
            onClick={() => setPage(effectivePage + 1)}
          >
            <ChevronRight size={15} />
          </Button>
        </div>
      </footer>
    </div>
  );
}
