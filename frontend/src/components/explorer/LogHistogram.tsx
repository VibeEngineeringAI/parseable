import { formatTimestamp } from './timezone';
import { parseEventTimestamp } from './timestamp';
import type { LogRecord } from '../../lib/types';
export function LogHistogram({
  rows,
  bounds,
  aggregate,
  timezone = 'UTC',
}: {
  rows: LogRecord[];
  aggregate?: { bins: number[]; total: number };
  timezone?: string;
  bounds?: { startTime: string; endTime: string };
}) {
  const timestamps = rows
    .map((row) => parseEventTimestamp(row.p_timestamp))
    .filter(Number.isFinite);
  const min = bounds ? Date.parse(bounds.startTime) : Math.min(...timestamps);
  const max = bounds ? Date.parse(bounds.endTime) : Math.max(...timestamps);
  const bins = aggregate?.bins ?? Array.from({ length: 48 }, () => 0);
  if (!aggregate)
    timestamps.forEach((t) => {
      bins[Math.max(0, Math.min(47, Math.floor(((t - min) / Math.max(1, max - min)) * 48)))]++;
    });
  const peak = Math.max(...bins, 1);
  return (
    <section className="histogram" aria-label="Event distribution">
      <div className="panel-heading">
        <h2>Logs over time</h2>
        <span className="muted">
          {aggregate
            ? `${aggregate.total.toLocaleString()} matching events`
            : `${rows.length} returned events`}
        </span>
      </div>
      <div
        className="histogram-plot"
        role="img"
        aria-label={`Distribution of ${aggregate?.total ?? timestamps.length} timestamped events across 48 time buckets`}
      >
        <div className="chart-grid" />
        {bins.map((count, i) => (
          <div
            className="histogram-column"
            key={i}
            title={`${Number.isFinite(min) ? `${formatTimestamp(min + i * Math.ceil((max - min) / 48), timezone)} · ` : ''}${count} events`}
          >
            <div
              className="histogram-bar"
              style={{ height: `${(count / peak) * 100}%`, minHeight: count ? 3 : 0 }}
            />
          </div>
        ))}
      </div>
      <div className="chart-axis legend-list legend-list-fit">
        <span>{bounds || timestamps.length ? formatTimestamp(min, timezone) : 'Start'}</span>
        <span>
          {aggregate ? 'All matching events · elapsed intervals' : 'Returned rows'} · {timezone}
        </span>
        <span>{bounds || timestamps.length ? formatTimestamp(max, timezone) : 'End'}</span>
      </div>
    </section>
  );
}
