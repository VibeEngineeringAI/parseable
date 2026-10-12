import { formatTimestamp } from './timezone';

import type { HistogramAggregate } from '../../lib/logQuery';

export function LogHistogram({
  aggregate,
  timezone = 'UTC',
}: {
  aggregate: HistogramAggregate;
  timezone?: string;
}) {
  const { bins, total, start, end, interval } = aggregate;
  const peak = Math.max(...bins, 1);
  return (
    <section className="histogram" aria-label="Event distribution">
      <div className="panel-heading">
        <h2>Logs over time</h2>
        <span className="muted">{total.toLocaleString()} matching events</span>
      </div>
      <div
        className="histogram-plot"
        role="img"
        aria-label={`Distribution of ${total} timestamped events across ${bins.length} time buckets`}
      >
        <div className="chart-grid" />
        {bins.map((count, i) => (
          <div
            className="histogram-column"
            key={i}
            title={`${formatTimestamp(start + i * interval, timezone)} · ${count} events`}
          >
            <div
              className="histogram-bar"
              style={{ height: `${(count / peak) * 100}%`, minHeight: count ? 3 : 0 }}
            />
          </div>
        ))}
      </div>
      <div className="chart-axis legend-list legend-list-fit">
        <span>{formatTimestamp(start, timezone)}</span>
        <span>All matching events · elapsed intervals · {timezone}</span>
        <span>{formatTimestamp(end, timezone)}</span>
      </div>
    </section>
  );
}
