import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowDown, ArrowUp, ArrowUpRight, Search, Boxes } from 'lucide-react';
import { EmptyState, Input, Select } from '../../components/ui';
import { apmServicePath, type ApmMetric, type ApmService } from '../../lib/apm';
import './apm.css';

export const apmLatencyLabels: Record<ApmMetric, string> = {
  avgMs: 'Average',
  p50Ms: 'P50',
  p95Ms: 'P95',
  p99Ms: 'P99',
  maxMs: 'Maximum',
};
export function formatApmDuration(value: number | null) {
  if (value == null) return '—';
  if (value >= 1000)
    return `${(value / 1000).toLocaleString(undefined, { maximumFractionDigits: 2 })} s`;
  return `${value.toLocaleString(undefined, { maximumFractionDigits: 2 })} ms`;
}
export function formatApmPercent(value: number) {
  return `${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}%`;
}
export function ServiceInventory({
  services,
  dataset,
  search,
  onSearchChange,
  metric,
  onMetricChange,
  suffix = '',
}: {
  services: ApmService[];
  dataset: string;
  search: string;
  onSearchChange: (search: string) => void;
  metric: ApmMetric;
  onMetricChange: (metric: ApmMetric) => void;
  suffix?: string;
}) {
  const [sort, setSort] = useState<{
    field: 'service' | 'spanCount' | 'traceCount' | 'errorRate' | 'latency';
    ascending: boolean;
  }>({ field: 'spanCount', ascending: false });
  const rows = useMemo(
    () =>
      services
        .filter((row) => row.service.toLowerCase().includes(search.toLowerCase()))
        .sort((a, b) => {
          const field = sort.field === 'latency' ? metric : sort.field;
          const left = a[field],
            right = b[field];
          // Missing latency always follows measured services.
          if (left == null) return right == null ? a.service.localeCompare(b.service) : 1;
          if (right == null) return -1;
          const comparison =
            typeof left === 'string' && typeof right === 'string'
              ? left.localeCompare(right)
              : Number(left) - Number(right);
          return (sort.ascending ? comparison : -comparison) || a.service.localeCompare(b.service);
        }),
    [services, search, sort, metric],
  );
  const heading = (field: typeof sort.field, label: string) => (
    <th
      scope="col"
      aria-sort={sort.field === field ? (sort.ascending ? 'ascending' : 'descending') : 'none'}
    >
      <button
        type="button"
        className="apm-sort"
        onClick={() =>
          setSort({
            field,
            ascending: sort.field === field ? !sort.ascending : field === 'service',
          })
        }
      >
        {label}
        {sort.field === field && (sort.ascending ? <ArrowUp size={13} /> : <ArrowDown size={13} />)}
      </button>
    </th>
  );
  return (
    <section className="apm-panel" aria-label="Service inventory">
      <div className="apm-panel-toolbar">
        <div className="apm-search">
          <Search size={16} aria-hidden="true" />
          <Input
            aria-label="Search services"
            placeholder="Search for services"
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
          />
        </div>
        <Select
          aria-label="Select latency metric"
          value={metric}
          onChange={(e) => onMetricChange(e.target.value as ApmMetric)}
        >
          {Object.entries(apmLatencyLabels).map(([value, label]) => (
            <option value={value} key={value}>
              {label} latency
            </option>
          ))}
        </Select>
        <span className="muted apm-result-count" role="status">
          {rows.length} of {services.length} services
        </span>
      </div>
      {rows.length ? (
        <div className="apm-table-scroll">
          <table className="apm-table">
            <caption className="charts-sr-only">
              Services aggregated from unique spans in the captured time range
            </caption>
            <thead>
              <tr>
                {heading('service', 'Service')}
                {heading('spanCount', 'Spans')}
                {heading('traceCount', 'Traces')}
                {heading('errorRate', 'Span error rate')}
                {heading('latency', `${apmLatencyLabels[metric]} latency`)}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.service}>
                  <td>
                    <Link
                      className="apm-service-link"
                      to={`${apmServicePath(dataset, row.service)}${suffix}`}
                    >
                      <span className="apm-service-icon">
                        <Boxes size={16} />
                      </span>
                      <strong>{row.service}</strong>
                      <ArrowUpRight size={14} />
                    </Link>
                  </td>
                  <td>{row.spanCount.toLocaleString()}</td>
                  <td>{row.traceCount.toLocaleString()}</td>
                  <td>
                    <span className={row.errorCount ? 'apm-error' : 'muted'}>
                      {formatApmPercent(row.errorRate)}
                    </span>
                    <span className="apm-secondary">
                      {row.errorCount.toLocaleString()} error spans
                    </span>
                  </td>
                  <td className="apm-latency-cell">
                    <span>{formatApmDuration(row[metric])}</span>
                    {row[metric] != null && (
                      <div className="apm-latency-track" aria-hidden="true">
                        <span
                          style={{
                            width: `${Math.max(2, (100 * (row[metric] ?? 0)) / Math.max(1, ...services.map((s) => s[metric] ?? 0)))}%`,
                          }}
                        />
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState
          title={search ? 'No matching services' : 'No services in this range'}
          description={
            search
              ? 'Try a different service name or clear your search.'
              : 'Choose a wider time range or ingest OpenTelemetry traces.'
          }
        />
      )}
    </section>
  );
}
