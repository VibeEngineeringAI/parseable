import { useCallback } from 'react';
import { useApp } from '../../app/AppProvider';
import { useAsync } from '../../hooks/useAsync';
import { PageHeader } from '../../components/explorer/PageHeader';
import { QueryState } from '../../components/explorer/QueryState';
import { Badge, Button, Card, EmptyState } from '../../components/ui';
import { ApiError } from '../../lib/apiError';
import type { ClusterNode, ClusterMetrics } from '../../lib/operationsContract';
import './cluster.css';
export function ClusterOverview({
  nodes,
  metrics = [],
}: {
  nodes: ClusterNode[];
  metrics?: ClusterMetrics[];
}) {
  return nodes.length === 0 ? (
    <EmptyState
      title="No cluster nodes"
      description="No registered distributed nodes were returned by this instance."
    />
  ) : (
    <div className="cluster-nodes">
      {nodes.map((node) => {
        const metric = metrics.find(
          (m) => m.address.replace(/\/$/, '') === node.domain_name.replace(/\/$/, ''),
        );
        return (
          <Card key={`${node.node_type}:${node.domain_name}`} className="cluster-node">
            <div className="inline">
              <h2>{node.node_type}</h2>
              <Badge tone={node.reachable ? 'success' : 'danger'}>
                {node.reachable ? 'Reachable' : 'Unreachable'}
              </Badge>
            </div>
            <p className="cluster-address">{node.domain_name}</p>
            <dl>
              <dt>Staging</dt>
              <dd>{node.staging_path || 'Unavailable'}</dd>
              <dt>Storage</dt>
              <dd>{node.storage_path || 'Unavailable'}</dd>
              <dt>Status</dt>
              <dd>{node.status || node.error || 'Unavailable'}</dd>
              {metric && (
                <>
                  <dt>Events ingested</dt>
                  <dd>{metric.parseable_events_ingested?.toLocaleString() ?? 'Unavailable'}</dd>
                  <dt>Resident memory</dt>
                  <dd>
                    {metric.process_resident_memory_bytes === null
                      ? 'Unavailable'
                      : `${(metric.process_resident_memory_bytes / 1024 / 1024).toFixed(1)} MiB`}
                  </dd>
                  <dt>Average CPU usage</dt>
                  <dd>
                    {metric.process_cpu_usage_percent_avg === null
                      ? 'Unavailable'
                      : `${metric.process_cpu_usage_percent_avg.toFixed(1)}%`}
                  </dd>
                  <dt>Staging files</dt>
                  <dd>{metric.parseable_staging_files?.toLocaleString() ?? 'Unavailable'}</dd>
                </>
              )}
            </dl>
          </Card>
        );
      })}
    </div>
  );
}
export function ClusterPage() {
  const { mode, client } = useApp();
  const nodes = useAsync(useCallback((signal) => client.clusterNodes(signal), [mode, client]));
  const metrics = useAsync(useCallback((signal) => client.clusterMetrics(signal), [mode, client]));
  const unsupported = nodes.error instanceof ApiError && [404, 405].includes(nodes.error.status);
  return (
    <div className="page">
      <PageHeader
        title="Cluster"
        description="Registered nodes, reachability and resource usage."
        actions={
          <Button
            onClick={() => {
              nodes.reload();
              metrics.reload();
            }}
          >
            Refresh
          </Button>
        }
      />
      {mode === 'demo' && <Badge>Sample cluster</Badge>}
      {unsupported ? (
        <EmptyState
          title="Cluster information unavailable"
          description="This server mode does not expose distributed cluster administration."
        />
      ) : (
        <>
          <QueryState loading={nodes.loading} error={nodes.error} retry={nodes.reload} />
          {nodes.data && (
            <>
              <QueryState loading={metrics.loading} error={metrics.error} retry={metrics.reload} />
              <ClusterOverview nodes={nodes.data} metrics={metrics.data} />
            </>
          )}
        </>
      )}
    </div>
  );
}
