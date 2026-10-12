import { useMemo, useState, type KeyboardEvent } from 'react';
import { AlertCircle, GitBranch } from 'lucide-react';
import { EmptyState, Input } from '../../components/ui';
import type { TraceDetailRecord } from '../../lib/types';
import { buildWaterfall, formatDuration } from './helpers';

export function SpanWaterfall({
  records,
  selectedId,
  onSelect,
}: {
  records: TraceDetailRecord[];
  selectedId?: string;
  onSelect: (span: TraceDetailRecord) => void;
}) {
  const [search, setSearch] = useState('');
  const { rows, totalMs } = useMemo(() => buildWaterfall(records), [records]);
  const ids = useMemo(() => new Set(records.map((span) => span.span_span_id)), [records]);
  const filtered = rows.filter(({ span }) =>
    `${span.span_name} ${span['service.name']} ${span.span_span_id}`
      .toLowerCase()
      .includes(search.toLowerCase().trim()),
  );
  const scale = totalMs || 1;
  const keyboard = (event: KeyboardEvent<HTMLUListElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const buttons = [
      ...event.currentTarget.querySelectorAll<HTMLButtonElement>('button[data-span-id]'),
    ];
    const index = buttons.indexOf(event.target as HTMLButtonElement);
    if (index < 0 || !buttons.length) return;
    event.preventDefault();
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? buttons.length - 1
          : Math.max(0, Math.min(buttons.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)));
    buttons[next].focus();
  };
  return (
    <section className="traces-waterfall" aria-label="Span waterfall" data-testid="span-waterfall">
      <div className="traces-section-heading">
        <h2>
          <GitBranch size={16} aria-hidden="true" />
          Span waterfall
        </h2>
        <span className="muted">
          {records.length.toLocaleString()} spans · {formatDuration(totalMs)}
        </span>
      </div>
      <Input
        aria-label="Search spans"
        placeholder="Search spans…"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
      />
      <p className="traces-keyboard-hint muted">
        Use ↑ / ↓ to move between spans; Enter to select. Times are relative to trace start.
      </p>
      <div className="traces-waterfall-scroll" role="region" aria-label="Span timing" tabIndex={0}>
        <div className="traces-waterfall-axis" aria-hidden="true">
          <span>Service / operation</span>
          <div>
            {[0, 0.25, 0.5, 0.75, 1].map((fraction) => (
              <span key={fraction}>{formatDuration(totalMs * fraction)}</span>
            ))}
          </div>
        </div>
        <ul className="traces-span-list" onKeyDown={keyboard}>
          {filtered.map(({ span, depth, offsetMs, durationMs, timingAvailable }) => {
            const orphan = !!span.span_parent_span_id && !ids.has(span.span_parent_span_id);
            return (
              <li key={span.span_span_id}>
                <button
                  type="button"
                  data-span-id={span.span_span_id}
                  className="traces-span-row"
                  aria-pressed={selectedId === span.span_span_id}
                  aria-label={`${span.span_name || 'Unnamed span'}, ${span['service.name']}, ${formatDuration(durationMs)}${span.has_error ? ', Error' : ''}${orphan ? ', Parent unavailable' : ''}${!timingAvailable ? ', Timing unavailable' : ''}`}
                  onClick={() => onSelect(span)}
                >
                  <span
                    className="traces-span-label"
                    style={{ paddingInlineStart: `${12 + Math.min(depth, 12) * 12}px` }}
                  >
                    <span className="traces-span-name">
                      {span.has_error && (
                        <AlertCircle size={13} className="traces-error-icon" aria-hidden="true" />
                      )}
                      {span.span_name || 'Unnamed span'}
                    </span>
                    <span className="muted traces-span-service">
                      {span['service.name']}
                      {orphan && ' · Parent unavailable'}
                      {depth > 12 && ` · Depth ${depth}`}
                    </span>
                  </span>
                  <span className="traces-span-track" aria-hidden="true">
                    {timingAvailable ? (
                      <span
                        className="traces-span-bar"
                        data-error={span.has_error}
                        style={{
                          left: `${(offsetMs / scale) * 100}%`,
                          width: `${(durationMs / scale) * 100}%`,
                        }}
                      />
                    ) : (
                      <span className="muted">Timing unavailable</span>
                    )}
                  </span>
                  <span className="traces-span-duration">{formatDuration(durationMs)}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
      {!filtered.length && (
        <EmptyState
          title="No matching spans"
          description="Search by operation, service, or span ID."
        />
      )}
      {search && (
        <p role="status" className="muted">
          Showing {filtered.length} of {rows.length} spans
        </p>
      )}
    </section>
  );
}
