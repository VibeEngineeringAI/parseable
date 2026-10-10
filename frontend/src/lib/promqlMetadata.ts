import { matcher, validateRange } from './promql';
import type { ParseableClient, PromqlMetadataRequest } from './types';
export interface PromqlMetadataSource {
  metricNames(signal?: AbortSignal): Promise<string[]>;
  labelNames(metric?: string, signal?: AbortSignal): Promise<string[]>;
  labelValues(label: string, metric?: string, signal?: AbortSignal): Promise<string[]>;
}

export type Bounds = { start: number; end: number };
export function boundsError(bounds: Bounds): string | undefined {
  return validateRange({ ...bounds, step: Math.max(1, bounds.end - bounds.start) });
}
export function metadataRequest(
  stream: string,
  bounds?: Bounds,
  metrics: string[] = [],
): PromqlMetadataRequest | undefined {
  if (!stream || (bounds && boundsError(bounds))) return;
  return {
    stream,
    ...bounds,
    limit: 1000,
    ...(metrics.length ? { match: metrics.map((name) => `{${matcher('__name__', name)}}`) } : {}),
  };
}
// Shared by Metrics, Alerts and Dashboards, with the LabelBrowser's bounds rules.
export function createPromqlMetadata(
  client: ParseableClient,
  stream: string,
  bounds?: Bounds,
): PromqlMetadataSource {
  return {
    metricNames: async (signal) => {
      const request = metadataRequest(stream, bounds);
      return request ? (await client.promqlLabelValues('__name__', request, signal)).data : [];
    },
    labelNames: async (metric, signal) => {
      const request = metadataRequest(stream, bounds, metric ? [metric] : []);
      return request ? (await client.promqlLabels(request, signal)).data : [];
    },
    labelValues: async (label, metric, signal) => {
      const request = metadataRequest(stream, bounds, metric ? [metric] : []);
      return request ? (await client.promqlLabelValues(label, request, signal)).data : [];
    },
  };
}
