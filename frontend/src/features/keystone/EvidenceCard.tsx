import { useState } from 'react';
import { Badge, Button } from '../../components/ui';
import { formatInstant } from '../../lib/keystone/context';
import type { CellValue, Evidence } from '../../lib/keystone/types';

const PREVIEW_ROWS = 8;

const STATUS: Record<
  Evidence['status'],
  { label: string; tone: 'success' | 'neutral' | 'warning' | 'danger' }
> = {
  ok: { label: 'Returned rows', tone: 'success' },
  empty: { label: 'No matching rows', tone: 'neutral' },
  denied: { label: 'Access denied', tone: 'danger' },
  error: { label: 'Query failed', tone: 'danger' },
  expired: { label: 'Expired', tone: 'warning' },
};

function cellText(value: CellValue) {
  if (value === null) return '∅';
  return String(value);
}

/** Bounded result preview. Cell text is rendered as text only, never as markup. */
function ResultsTable({ evidence }: { evidence: Evidence }) {
  const [expanded, setExpanded] = useState(false);
  const rows = expanded ? evidence.rows : evidence.rows.slice(0, PREVIEW_ROWS);
  return (
    <div className="ks-results">
      <div
        className="ks-results-scroll"
        tabIndex={0}
        role="region"
        aria-label={`${evidence.title} results`}
      >
        <table>
          <thead>
            <tr>
              {evidence.columns.map((column) => (
                <th key={column} scope="col">
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={index}>
                {row.map((value, column) => (
                  <td key={column} data-null={value === null || undefined}>
                    {cellText(value)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="ks-results-meta">
        Showing {rows.length} of {evidence.rowCount.toLocaleString('en-US')} rows
        {evidence.truncated ? '; the stored result was truncated at the row limit' : ''}.
        {evidence.rows.length > PREVIEW_ROWS ? (
          <Button size="sm" variant="ghost" onClick={() => setExpanded((value) => !value)}>
            {expanded ? 'Show fewer rows' : `Show all ${evidence.rows.length} returned rows`}
          </Button>
        ) : null}
      </p>
    </div>
  );
}

export function EvidenceCard({ evidence }: { evidence: Evidence }) {
  const status = STATUS[evidence.status];
  return (
    <section
      className="ks-evidence"
      aria-labelledby={`ks-ev-${evidence.id}`}
      data-testid={`ks-evidence-${evidence.id}`}
    >
      <header className="ks-evidence-header">
        <h4 id={`ks-ev-${evidence.id}`}>{evidence.title}</h4>
        <Badge tone={status.tone}>{status.label}</Badge>
      </header>
      <dl className="ks-facts">
        <div>
          <dt>Datasets</dt>
          <dd>{evidence.datasets.join(', ')}</dd>
        </div>
        <div>
          <dt>Window</dt>
          <dd>
            {formatInstant(evidence.start)} to {formatInstant(evidence.end)}
          </dd>
        </div>
        <div>
          <dt>Ran</dt>
          <dd>{formatInstant(evidence.executedAt)}</dd>
        </div>
      </dl>
      {evidence.sql.trim() ? (
        <details className="ks-sql">
          <summary>Executed SQL</summary>
          <pre>
            <code>{evidence.sql}</code>
          </pre>
        </details>
      ) : (
        <p className="ks-muted">Collected with a bounded, scoped sample.</p>
      )}
      {evidence.status === 'ok' && evidence.rows.length > 0 ? (
        <ResultsTable evidence={evidence} />
      ) : evidence.status === 'empty' ? (
        <p className="ks-muted">The query succeeded and returned no rows for this window.</p>
      ) : evidence.status === 'expired' ? (
        <p className="ks-muted">
          The stored rows have expired. The source details above are kept; it is not re-run
          automatically.
        </p>
      ) : evidence.status === 'denied' ? (
        <p className="ks-muted">You no longer have access to a dataset this result depends on.</p>
      ) : evidence.status === 'error' ? (
        <p className="ks-muted">
          This query failed. The answer marks the coverage it could not check.
        </p>
      ) : null}
    </section>
  );
}
