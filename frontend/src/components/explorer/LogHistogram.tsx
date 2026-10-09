import { parseEventTimestamp } from './timestamp';
import type { LogRecord } from '../../lib/types';
export function LogHistogram({
  rows,
  bounds,
}: {
  rows: LogRecord[];
  bounds?: { startTime: string; endTime: string };
}) {
  const timestamps = rows
    .map((row) => parseEventTimestamp(row.p_timestamp))
    .filter(Number.isFinite);
  const min = bounds ? Date.parse(bounds.startTime) : Math.min(...timestamps);
  const max = bounds ? Date.parse(bounds.endTime) : Math.max(...timestamps);
  const bins = Array.from({ length: 48 }, () => 0);
  timestamps.forEach((t) => {
    bins[Math.max(0, Math.min(47, Math.floor(((t - min) / Math.max(1, max - min)) * 48)))]++;
  });
  const peak = Math.max(...bins, 1);
  return (
    <section className="histogram" aria-label="Event distribution">
      <div className="panel-heading">
        <h2>Logs over time</h2>
        <span className="muted">{rows.length} returned events</span>
      </div>
      <div
        className="histogram-plot"
        role="img"
        aria-label={`Distribution of ${timestamps.length} timestamped events across 48 time buckets`}
      >
        <div className="chart-grid" />
        {bins.map((count, i) => (
          <div className="histogram-column" key={i} title={`${count} events`}>
            <div
              className="histogram-bar"
              style={{ height: `${(count / peak) * 100}%`, minHeight: count ? 3 : 0 }}
            />
          </div>
        ))}
      </div>
      <div className="chart-axis legend-list legend-list-fit">
        <span>
          {timestamps.length ? new Date(min).toLocaleTimeString([], { timeZone: 'UTC' }) : 'Start'}
        </span>
        <span>Returned rows · UTC</span>
        <span>
          {timestamps.length ? new Date(max).toLocaleTimeString([], { timeZone: 'UTC' }) : 'End'}
        </span>
      </div>
    </section>
  );
}
