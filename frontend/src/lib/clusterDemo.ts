import type { ClusterNode } from './operationsContract';
export const demoClusterNodes: ClusterNode[] = [
  {
    domain_name: 'https://ingestor-1.demo',
    reachable: true,
    node_type: 'ingestor',
    staging_path: '/var/parseable/staging',
    storage_path: 's3://demo-logs',
    error: null,
    status: '200 OK',
  },
  {
    domain_name: 'https://querier-1.demo',
    reachable: true,
    node_type: 'querier',
    staging_path: '/var/parseable/staging',
    storage_path: 's3://demo-logs',
    error: null,
    status: '200 OK',
  },
];
export const demoClusterMetrics = demoClusterNodes.map((node) => ({
  address: node.domain_name,
  node_type: node.node_type,
  parseable_events_ingested: 125000,
  process_resident_memory_bytes: 268435456,
  process_cpu_usage_percent_avg: 12.4,
  parseable_staging_files: 4,
}));
