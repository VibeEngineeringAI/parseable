import { object, strings } from './teamContract';
import type { PromqlInstantResult, PromqlLabels, PromqlRangeResult, PromqlSample } from './types';

function labels(value: unknown): value is PromqlLabels {
  return object(value) && Object.values(value).every((label) => typeof label === 'string');
}

function sample(value: unknown): value is PromqlSample {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === 'number' &&
    Number.isFinite(value[0]) &&
    typeof value[1] === 'string'
  );
}

export function rangeResult(value: unknown): value is PromqlRangeResult {
  return (
    object(value) &&
    value.resultType === 'matrix' &&
    Array.isArray(value.result) &&
    value.result.every(
      (series) =>
        object(series) &&
        labels(series.metric) &&
        Array.isArray(series.values) &&
        series.values.every(sample),
    )
  );
}

export function instantResult(value: unknown): value is PromqlInstantResult {
  if (!object(value)) return false;
  if (value.resultType === 'matrix') return rangeResult(value);
  if (value.resultType === 'scalar' || value.resultType === 'string') return sample(value.result);
  return (
    value.resultType === 'vector' &&
    Array.isArray(value.result) &&
    value.result.every((series) => object(series) && labels(series.metric) && sample(series.value))
  );
}

export function successEnvelope(
  value: unknown,
): value is { status: 'success'; data: unknown; warnings?: string[] } {
  return (
    object(value) &&
    value.status === 'success' &&
    Object.hasOwn(value, 'data') &&
    (value.warnings === undefined || strings(value.warnings))
  );
}
