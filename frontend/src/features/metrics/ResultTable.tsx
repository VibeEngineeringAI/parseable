import { useState } from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown, Download } from 'lucide-react';
import { Button, EmptyState, Spinner } from '../../components/ui';
import { exportRecords } from '../../components/explorer/DataTable';
import { Pagination, PAGE_SIZE } from '../../components/ui/Pagination';
import { formatValue } from '../../lib/promql';
import type { LogRecord } from '../../lib/types';

export function ResultTable({
  title,
  rows,
  columns,
  empty,
  loading = false,
}: {
  title: string;
  rows: LogRecord[];
  columns: string[];
  empty: string;
  /** Requests are still pending and nothing has arrived yet, so "empty" would be misleading. */
  loading?: boolean;
}) {
  const [sort, setSort] = useState<{ field: string; descending: boolean }>();
  const ordered = sort
    ? [...rows].sort((left, right) => {
        const a = left[sort.field],
          b = right[sort.field];
        const result =
          typeof a === 'number' && typeof b === 'number'
            ? a - b
            : String(a ?? '').localeCompare(String(b ?? ''), undefined, { numeric: true });
        return sort.descending ? -result : result;
      })
    : rows;
  const [page, setPage] = useState(0);
  const pageSize = PAGE_SIZE;
  const pages = Math.max(1, Math.ceil(rows.length / pageSize));
  const currentPage = Math.min(page, pages - 1);
  return (
    <section className="metrics-table-section" aria-label={title}>
      <div className="panel-heading">
        <div>
          <h2>{title}</h2>
          <span className="muted">
            {rows.length} {rows.length === 1 ? 'result' : 'results'}
          </span>
        </div>
        <div className="inline wrap">
          <Button
            size="sm"
            variant="ghost"
            disabled={!rows.length}
            onClick={() => exportRecords(ordered, 'json')}
          >
            <Download size={14} aria-hidden="true" />
            Export JSON
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={!rows.length}
            onClick={() => exportRecords(ordered, 'csv')}
          >
            Export CSV
          </Button>
        </div>
      </div>
      {!rows.length ? (
        loading ? (
          <div className="loading-state">
            <Spinner label="Loading results" />
            Loading results…
          </div>
        ) : (
          <EmptyState title={empty} />
        )
      ) : (
        <>
          <div className="table-scroll">
            <table>
              <caption className="sr-only">{title}</caption>
              <thead>
                <tr>
                  {columns.map((field) => (
                    <th
                      scope="col"
                      key={field}
                      aria-sort={
                        sort?.field === field
                          ? sort.descending
                            ? 'descending'
                            : 'ascending'
                          : 'none'
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
                        {field}
                        {sort?.field === field ? (
                          sort.descending ? (
                            <ArrowDown size={12} aria-hidden="true" />
                          ) : (
                            <ArrowUp size={12} aria-hidden="true" />
                          )
                        ) : (
                          <ArrowUpDown size={12} aria-hidden="true" />
                        )}
                      </button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {ordered
                  .slice(currentPage * pageSize, (currentPage + 1) * pageSize)
                  .map((row, index) => (
                    <tr key={index}>
                      {columns.map((field) => (
                        <td
                          key={field}
                          className={`mono ${field === 'Series' ? 'metrics-series-cell' : ''}`}
                        >
                          {field === 'Series'
                            ? String(row[field])
                            : formatValue(row[field] == null ? NaN : (row[field] as number))}
                          {field === 'Value' && typeof row.Samples === 'number' && (
                            <span className="metrics-sample-hint muted">{row.Samples} samples</span>
                          )}
                        </td>
                      ))}
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
          {pages > 1 && (
            <Pagination
              page={currentPage}
              total={rows.length}
              noun="results"
              onPageChange={setPage}
            />
          )}
        </>
      )}
    </section>
  );
}
