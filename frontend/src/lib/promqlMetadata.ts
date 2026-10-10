import { matcher } from './promql';
import type { ParseableClient } from './types';
import type { PromqlMetadataSource } from '../components/promql/completion';
// Metadata is scoped to dataset and an anchored range; typing and running never reset it.
export function createPromqlMetadata(
  client: ParseableClient,
  stream: string,
  bounds?: { start: number; end: number },
): PromqlMetadataSource {
  const request = (metric?: string) => ({
    stream,
    ...bounds,
    limit: 1000,
    ...(metric ? { match: [`{${matcher('__name__', metric)}}`] } : {}),
  });
  const valid =
    !!stream &&
    (!bounds ||
      (Number.isFinite(bounds.start) &&
        Number.isFinite(bounds.end) &&
        bounds.start <= bounds.end &&
        bounds.end - bounds.start <= 31 * 86400));
  return {
    metricNames: async (signal) =>
      valid ? (await client.promqlLabelValues('__name__', request(), signal)).data : [],
    labelNames: async (metric, signal) =>
      valid ? (await client.promqlLabels(request(metric), signal)).data : [],
    labelValues: async (label, metric, signal) =>
      valid ? (await client.promqlLabelValues(label, request(metric), signal)).data : [],
  };
}
