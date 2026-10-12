import { parseEventTimestamp } from '../../components/explorer/timestamp';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowUpRight, ChevronRight } from 'lucide-react';
import { EmptyState, Input, Tabs } from '../../components/ui';
import { TimeSeriesChart } from '../../components/charts/TimeSeriesChart';
import {
  apmBucketInterval,
  formatApmRate,
  apmServicePath,
  apmTracePath,
  type ApmBounds,
  type ApmInsights,
  type ApmMetric,
  type ApmStats,
} from '../../lib/apm';
import { apmLatencyLabels, formatApmDuration, formatApmPercent } from './ServiceInventory';
import './apm.css';

export function ApmStatCards({
  stats,
  bounds,
  timeColumn = 'p_timestamp',
}: {
  stats: ApmStats;
  bounds: ApmBounds;
  timeColumn?: string;
}) {
  const perSecond =
    stats.spanCount / ((Date.parse(bounds.endTime) - Date.parse(bounds.startTime)) / 1000);
  return (
    <dl className="apm-stat-grid">
      <div className="apm-stat">
        <dt>{timeColumn === 'p_timestamp' ? 'Ingested spans' : 'Observed spans'}</dt>
        <dd>{stats.spanCount.toLocaleString()}</dd>
        <dd className="apm-stat-note">{formatApmRate(perSecond)} spans / second</dd>
      </div>
      <div className="apm-stat">
        <dt>Distinct traces</dt>
        <dd>{stats.traceCount.toLocaleString()}</dd>
        <dd className="apm-stat-note">Within this service</dd>
      </div>
      <div className="apm-stat">
        <dt>Span error rate</dt>
        <dd className={stats.errorCount ? 'apm-error' : ''}>{formatApmPercent(stats.errorRate)}</dd>
        <dd className="apm-stat-note">{stats.errorCount.toLocaleString()} explicit error spans</dd>
      </div>
      <div className="apm-stat">
        <dt>P95 span latency</dt>
        <dd>{formatApmDuration(stats.p95Ms)}</dd>
        <dd className="apm-stat-note">Approximate percentile</dd>
      </div>
    </dl>
  );
}
export function ServiceInsights({
  insights,
  dataset,
  service,
  bounds,
  suffix = '',
  timeColumn = 'p_timestamp',
}: {
  insights: ApmInsights;
  dataset: string;
  service: string;
  bounds: ApmBounds;
  suffix?: string;
  timeColumn?: string;
}) {
  const [search, setSearch] = useState(''),
    [tab, setTab] = useState('red');
  const series = useMemo(() => {
    const start = Date.parse(bounds.startTime),
      end = Date.parse(bounds.endTime),
      interval = apmBucketInterval(bounds);
    const buckets = new Map(
      insights.series.map((bucket) => [
        Math.round((parseEventTimestamp(bucket.bucket) - start) / interval),
        bucket,
      ]),
    );
    const times: number[] = [],
      rate: number[] = [],
      errors: number[] = [],
      average: (number | null)[] = [],
      p95: (number | null)[] = [],
      p99: (number | null)[] = [];
    for (let i = 0; start + i * interval < end; i++) {
      const time = start + i * interval,
        bucket = buckets.get(i),
        seconds = Math.min(interval, end - time) / 1000;
      times.push(time / 1000);
      rate.push((bucket?.spanCount ?? 0) / seconds);
      errors.push(bucket?.errorCount ?? 0);
      average.push(bucket?.avgMs ?? null);
      p95.push(bucket?.p95Ms ?? null);
      p99.push(bucket?.p99Ms ?? null);
    }
    return { times, rate, errors, average, p95, p99 };
  }, [insights.series, bounds]);
  const operations = insights.operations.rows.filter((row) =>
    row.operation.toLowerCase().includes(search.toLowerCase()),
  );
  const xRange = [Date.parse(bounds.startTime) / 1000, Date.parse(bounds.endTime) / 1000] as const;
  if (!insights.summary.spanCount)
    return (
      <EmptyState
        title="No spans for this service"
        description="This service has no observed spans in the selected time range. Try a wider range."
        action={
          <Link className="text-link" to={`${apmServicePath(dataset)}${suffix}`}>
            Back to services
          </Link>
        }
      />
    );
  return (
    <div className="apm-insights">
      <div className="apm-insight-header">
        <div className="stack">
          <nav className="apm-breadcrumb" aria-label="APM breadcrumb">
            <Link to={`${apmServicePath(dataset)}${suffix}`}>All services</Link>
            <ChevronRight size={13} />
            <span>{service}</span>
          </nav>
          <h2>{service}</h2>
        </div>
        <Link className="text-link" to={apmTracePath(dataset, service, bounds)}>
          Explore service traces <ArrowUpRight size={15} />
        </Link>
      </div>
      <ApmStatCards stats={insights.summary} bounds={bounds} timeColumn={timeColumn} />
      <Tabs
        aria-label="Service charts"
        value={tab}
        onValueChange={setTab}
        items={[
          {
            value: 'red',
            label: 'Rate & errors',
            content: (
              <div className="apm-chart-grid">
                <div className="apm-panel">
                  <TimeSeriesChart
                    title={
                      timeColumn === 'p_timestamp' ? 'Ingested span rate' : 'Observed span rate'
                    }
                    timestamps={series.times}
                    series={[{ id: 'rate', label: 'Spans / second', values: series.rate }]}
                    formatValue={(value) => `${formatApmRate(value)} /s`}
                    height={210}
                    fill
                    showSeriesCount={false}
                    xRange={xRange}
                  />
                </div>
                <div className="apm-panel">
                  <TimeSeriesChart
                    title="Explicit error spans"
                    timestamps={series.times}
                    series={[{ id: 'errors', label: 'Error spans', values: series.errors }]}
                    kind="bar"
                    formatValue={(value) => value.toLocaleString()}
                    height={210}
                    showSeriesCount={false}
                    xRange={xRange}
                  />
                </div>
              </div>
            ),
          },
          {
            value: 'latency',
            label: 'Latency',
            content: (
              <section className="apm-panel">
                <TimeSeriesChart
                  title="Span latency"
                  timestamps={series.times}
                  series={[
                    { id: 'avg', label: 'Average', values: series.average },
                    { id: 'p95', label: 'P95', values: series.p95 },
                    { id: 'p99', label: 'P99', values: series.p99 },
                  ]}
                  formatValue={formatApmDuration}
                  height={250}
                  showSeriesCount={false}
                  xRange={xRange}
                />
                <dl className="apm-percentiles">
                  {Object.entries(apmLatencyLabels).map(([metric, label]) => (
                    <div key={metric}>
                      <dt>{label}</dt>
                      <dd>{formatApmDuration(insights.summary[metric as ApmMetric])}</dd>
                    </div>
                  ))}
                </dl>
              </section>
            ),
          },
        ]}
      />
      <section className="apm-panel" aria-label="Service operations">
        <div className="apm-panel-heading">
          <div>
            <h2>Operations</h2>
            <p>Ranked by unique span volume</p>
          </div>
          <Input
            aria-label="Search operations"
            placeholder="Search for operations"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        {operations.length ? (
          <div className="apm-table-scroll">
            <table className="apm-table">
              <thead>
                <tr>
                  <th scope="col">Operation</th>
                  <th scope="col">Spans</th>
                  <th scope="col">Span error rate</th>
                  <th scope="col">Average</th>
                  <th scope="col">P95</th>
                  <th scope="col">P99</th>
                </tr>
              </thead>
              <tbody>
                {operations.map((row) => (
                  <tr key={row.operation}>
                    <td>{row.operation}</td>
                    <td>{row.spanCount.toLocaleString()}</td>
                    <td className={row.errorCount ? 'apm-error' : ''}>
                      {formatApmPercent(row.errorRate)}
                    </td>
                    <td>{formatApmDuration(row.avgMs)}</td>
                    <td>{formatApmDuration(row.p95Ms)}</td>
                    <td>{formatApmDuration(row.p99Ms)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState
            title="No matching operations"
            description="Try a different operation name."
          />
        )}
        {insights.operations.truncated && (
          <p className="apm-warning">
            Showing the 100 operations with the most spans. Search applies to these operations.
          </p>
        )}
      </section>
      <section className="apm-panel" aria-label="Spans to investigate">
        <div className="apm-panel-heading">
          <div>
            <h2>Spans to investigate</h2>
            <p>
              Explicit errors first, then longest duration. Select a trace to inspect its waterfall.
            </p>
          </div>
          <Link className="text-link" to={apmTracePath(dataset, service, bounds)}>
            View all traces <ArrowUpRight size={14} />
          </Link>
        </div>
        {insights.spans.rows.length ? (
          <div className="apm-table-scroll">
            <table className="apm-table">
              <thead>
                <tr>
                  <th scope="col">Operation / trace</th>
                  <th scope="col">Span status</th>
                  <th scope="col">Duration</th>
                  <th scope="col">Started (UTC)</th>
                </tr>
              </thead>
              <tbody>
                {insights.spans.rows.map((span) => (
                  <tr key={JSON.stringify([span.traceId, span.spanId])}>
                    <td>
                      <Link
                        className="text-link"
                        to={apmTracePath(dataset, service, bounds, span.traceId)}
                      >
                        {span.operation} <ArrowUpRight size={13} />
                      </Link>
                      <span className="apm-secondary">{span.traceId}</span>
                    </td>
                    <td className={span.error ? 'apm-error' : 'muted'}>
                      {span.error ? 'Error' : 'No explicit error'}
                    </td>
                    <td>{formatApmDuration(span.durationMs)}</td>
                    <td>
                      {new Date(parseEventTimestamp(span.startedAt))
                        .toISOString()
                        .replace('T', ' ')
                        .replace('Z', '')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState title="No spans available" description="Choose another time range." />
        )}
        {insights.spans.truncated && (
          <p className="apm-warning">
            Showing 50 prioritized spans. Open the trace explorer for more.
          </p>
        )}
      </section>
    </div>
  );
}
