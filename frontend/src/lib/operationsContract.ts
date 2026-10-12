import { ApiError } from './apiError';
export type ClusterNode = {
  domain_name: string;
  reachable: boolean;
  staging_path: string;
  storage_path: string;
  node_type: string;
  error: string | null;
  status: string | null;
};
export type ClusterMetrics = {
  address: string;
  node_type: string;
  parseable_events_ingested: number | null;
  process_resident_memory_bytes: number | null;
  process_cpu_usage_percent_avg: number | null;
  parseable_staging_files: number | null;
};
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
export function clusterNodes(value: unknown): ClusterNode[] {
  if (
    !Array.isArray(value) ||
    !value.every(
      (v) =>
        object(v) &&
        ['domain_name', 'staging_path', 'storage_path', 'node_type'].every(
          (k) => typeof v[k] === 'string',
        ) &&
        typeof v.reachable === 'boolean' &&
        ['error', 'status'].every((k) => v[k] === null || typeof v[k] === 'string'),
    )
  )
    throw new ApiError('Unexpected cluster information response', 502);
  return value as ClusterNode[];
}
export function clusterMetrics(value: unknown): ClusterMetrics[] {
  if (
    !Array.isArray(value) ||
    !value.every(
      (v) =>
        object(v) &&
        typeof v.address === 'string' &&
        typeof v.node_type === 'string' &&
        [
          'parseable_events_ingested',
          'process_resident_memory_bytes',
          'process_cpu_usage_percent_avg',
          'parseable_staging_files',
        ].every(
          (k) =>
            v[k] === null ||
            (typeof v[k] === 'number' && Number.isFinite(v[k]) && (v[k] as number) >= 0),
        ),
    )
  )
    throw new ApiError('Unexpected cluster metrics response', 502);
  return value as ClusterMetrics[];
}
