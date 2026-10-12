import { ServiceMap } from './ServiceMap';
import { Link } from 'react-router-dom';
import { ArrowRight, GitBranch } from 'lucide-react';
import { EmptyState } from '../../components/ui';
import { apmServicePath, type ApmEdge } from '../../lib/apm';
import { formatApmDuration, formatApmPercent } from './ServiceInventory';
import './apm.css';

/** Each edge comes from an observed cross-service parent span, never a name heuristic. */
export function ServiceTopology({
  edges,
  dataset,
  search = '',
  focusedService,
  suffix = '',
}: {
  edges: ApmEdge[];
  dataset: string;
  search?: string;
  focusedService?: string;
  suffix?: string;
}) {
  const visible = edges.filter(
    (edge) =>
      (!focusedService || edge.source === focusedService || edge.target === focusedService) &&
      `${edge.source} ${edge.target}`.toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <section className="apm-panel apm-dependencies" aria-label="Service dependencies">
      <div className="apm-panel-heading">
        <div>
          <h2>
            <GitBranch size={17} /> Observed dependencies
          </h2>
          <p>Parent → child relationships across services. Metrics describe child spans.</p>
        </div>
        <span className="muted">{visible.length} connections</span>
      </div>
      {visible.length ? (
        <>
          <ServiceMap
            edges={visible}
            dataset={dataset}
            focusedService={focusedService}
            suffix={suffix}
          />
          <ul className="apm-edge-list">
            {visible.map((edge) => (
              <li key={JSON.stringify([edge.source, edge.target])}>
                <div className="apm-edge-path">
                  <Link to={`${apmServicePath(dataset, edge.source)}${suffix}`}>{edge.source}</Link>
                  <ArrowRight size={20} aria-label="parent to child" />
                  <Link to={`${apmServicePath(dataset, edge.target)}${suffix}`}>{edge.target}</Link>
                </div>
                <dl className="apm-edge-stats">
                  <div>
                    <dt>Child spans</dt>
                    <dd>{edge.spanCount.toLocaleString()}</dd>
                  </div>
                  <div>
                    <dt>Span error rate</dt>
                    <dd className={edge.errorCount ? 'apm-error' : ''}>
                      {formatApmPercent((100 * edge.errorCount) / edge.spanCount)}
                    </dd>
                  </div>
                  <div>
                    <dt>Average latency</dt>
                    <dd>{formatApmDuration(edge.avgMs)}</dd>
                  </div>
                </dl>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <EmptyState
          title="No observed service dependencies"
          description="Cross-service connections need both a child span and its parent in this dataset and time range. Missing parents and ambiguous span identities are excluded."
        />
      )}
    </section>
  );
}
