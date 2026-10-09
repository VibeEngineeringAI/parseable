import {
  autoStep,
  matcher,
  metricSelector,
  parseSampleValue,
  seriesLabel,
  summarizeSeries,
  toChartSeries,
  validateRange,
} from '../../lib/promql';
import { timeBounds } from '../../lib/query';
import type {
  PromqlInstantResult,
  PromqlMetadataRequest,
  PromqlQueryRequest,
  PromqlRangeRequest,
  PromqlRangeResult,
  TimeRange,
} from '../../lib/types';

export const maxQueries = 5;
export type QueryType = 'range' | 'instant' | 'both';
export type ExplorerState = { queries: string[]; type: QueryType; step: string; range: TimeRange };
export type Bounds = { start: number; end: number };
export type RunSnapshot = Bounds & {
  stream: string;
  type: QueryType;
  step: string;
  queries: Array<{ id: string; query: string; resolvedStep: string }>;
};
export type QueryResult = {
  id: string;
  pending: number;
  range?: PromqlRangeResult;
  instant?: PromqlInstantResult;
  errors: Array<{ kind: 'range' | 'instant'; error: Error }>;
};

export const queryId = (index: number) => String.fromCharCode(65 + index);

export function parseExplorerSearch(search: string): ExplorerState {
  const params = new URLSearchParams(search);
  const queries = params.getAll('query').slice(0, maxQueries);
  const type = params.get('type');
  const step = params.get('step') ?? '';
  let range: TimeRange = '1h';
  const preset = params.get('range');
  if (preset && ['15m', '1h', '6h', '24h', '7d'].includes(preset)) range = preset as TimeRange;
  const start = params.get('start'),
    end = params.get('end');
  if (start && end && /^\d{4}-\d{2}-\d{2}T/.test(start) && /^\d{4}-\d{2}-\d{2}T/.test(end)) {
    const startSeconds = Date.parse(start) / 1000,
      endSeconds = Date.parse(end) / 1000;
    if (
      startSeconds < endSeconds &&
      !boundsError({
        start: startSeconds,
        end: endSeconds,
      })
    ) {
      range = { startTime: new Date(start).toISOString(), endTime: new Date(end).toISOString() };
    }
  }
  return {
    queries: queries.length ? queries : [''],
    type: type === 'range' || type === 'instant' ? type : 'both',
    step: stepError(step) ? '' : step,
    range,
  };
}

export function serializeExplorerState(state: ExplorerState): string {
  const params = new URLSearchParams();
  for (const query of state.queries.slice(0, maxQueries)) params.append('query', query);
  params.set('type', state.type);
  if (state.step) params.set('step', state.step);
  if (typeof state.range === 'string') params.set('range', state.range);
  else {
    params.set('start', state.range.startTime);
    params.set('end', state.range.endTime);
  }
  return `?${params}`;
}

export function rangeBounds(range: TimeRange, now = Date.now()): Bounds {
  const { startTime, endTime } = timeBounds(range, now);
  return { start: Date.parse(startTime) / 1000, end: Date.parse(endTime) / 1000 };
}

export function stepError(step: string): string | undefined {
  if (step.trim()) return validateRange({ start: 0, end: 0, step });
}

export function boundsError(bounds: Bounds): string | undefined {
  return validateRange({ ...bounds, step: Math.max(1, bounds.end - bounds.start) });
}

export function createRunSnapshot(
  state: ExplorerState,
  stream: string,
  width: number,
  now = Date.now(),
): { snapshot: RunSnapshot; error?: never } | { error: string; snapshot?: never } {
  const invalidStep = stepError(state.step);
  if (invalidStep) return { error: invalidStep };
  const bounds = rangeBounds(state.range, now);
  const queries = state.queries.flatMap((query, index) =>
    query.trim()
      ? [
          {
            id: queryId(index),
            query,
            resolvedStep: state.step.trim()
              ? state.step
              : `${autoStep({ ...bounds, width, query })}s`,
          },
        ]
      : [],
  );
  // An instant query still needs valid bounds, but has no evaluation-step count.
  const invalidBounds = boundsError(bounds);
  if (invalidBounds) return { error: invalidBounds };
  if (state.type !== 'instant') {
    for (const query of queries) {
      const error = validateRange({ ...bounds, step: query.resolvedStep });
      if (error) return { error: `${query.id} · ${error}` };
    }
  }
  if (!queries.length) return { error: 'Enter a PromQL query to run.' };
  return { snapshot: { ...bounds, stream, type: state.type, step: state.step, queries } };
}

export function snapshotState(snapshot: RunSnapshot, range: TimeRange): ExplorerState {
  // Preserve row IDs when some applied rows were empty.
  const queries = Array.from({ length: snapshot.queries.at(-1)!.id.charCodeAt(0) - 64 }, () => '');
  for (const row of snapshot.queries) queries[row.id.charCodeAt(0) - 65] = row.query;
  return { queries, type: snapshot.type, step: snapshot.step, range };
}

/**
 * Mirror removing the query at `index` from the panel. Query IDs are positional, so the
 * remaining snapshot rows are relabelled to match the panel and the removed row's results go away.
 */
export function removeSnapshotQuery(snapshot: RunSnapshot, index: number): RunSnapshot | undefined {
  const queries = snapshot.queries.flatMap((row) => {
    const position = row.id.charCodeAt(0) - 65;
    if (position === index) return [];
    return [{ ...row, id: queryId(position > index ? position - 1 : position) }];
  });
  return queries.length ? { ...snapshot, queries } : undefined;
}

export function requestsForSnapshot(
  snapshot: RunSnapshot,
): Array<
  | { id: string; kind: 'range'; request: PromqlRangeRequest }
  | { id: string; kind: 'instant'; request: PromqlQueryRequest }
> {
  return snapshot.queries.flatMap(({ id, query, resolvedStep }) => {
    const requests: ReturnType<typeof requestsForSnapshot> = [];
    if (snapshot.type !== 'instant')
      requests.push({
        id,
        kind: 'range',
        request: {
          stream: snapshot.stream,
          query,
          start: snapshot.start,
          end: snapshot.end,
          step: resolvedStep,
        },
      });
    if (snapshot.type !== 'range')
      requests.push({
        id,
        kind: 'instant',
        request: {
          stream: snapshot.stream,
          query,
          time: snapshot.end,
        },
      });
    return requests;
  });
}

export function metadataRequest(
  stream: string,
  bounds: Bounds,
  metrics: string[] = [],
): PromqlMetadataRequest | undefined {
  if (boundsError(bounds)) return;
  return {
    stream,
    ...bounds,
    limit: 1000,
    ...(metrics.length ? { match: metrics.map((name) => `{${matcher('__name__', name)}}`) } : {}),
  };
}

// Metadata bounds hold still across runs, so Run keeps the label browser and completion caches.
// Absolute ranges never move. A relative range re-anchors on Run only after the completion
// cache's lifetime, so new series still appear without a request on every Run.
export const metadataMaxAge = 60_000;

export function metadataAnchor(range: TimeRange, anchor: number, now = Date.now()): number {
  return typeof range === 'string' && now - anchor >= metadataMaxAge ? now : anchor;
}

export function selectorWithValue(metric: string, label: string, value: string): string {
  if (label === '__name__') return metricSelector(value);
  const selector = metricSelector(metric);
  const filter = matcher(label, value);
  return selector.startsWith('{')
    ? `${selector.slice(0, -1)}, ${filter}}`
    : `${selector}{${filter}}`;
}

export function insertBrowserQuery(
  queries: string[],
  active: number,
  metric: string,
  labelValue?: { label: string; value: string },
): { queries: string[]; active: number; error?: string } {
  const index = Math.max(0, Math.min(active, queries.length - 1));
  const current = queries[index].trim();
  const query = labelValue
    ? selectorWithValue(metric, labelValue.label, labelValue.value)
    : metricSelector(metric);
  const canReplace =
    !current ||
    (labelValue && [metricSelector(metric), `{${matcher('__name__', metric)}}`].includes(current));
  if (canReplace)
    return { queries: queries.map((text, row) => (row === index ? query : text)), active: index };
  if (queries.length >= maxQueries)
    return {
      queries,
      active: index,
      error: 'Remove a query to add another. Five queries are allowed.',
    };
  return { queries: [...queries, query], active: queries.length };
}

export function chartResults(results: QueryResult[], queryCount: number) {
  const charts = results.flatMap((row) => (row.range ? [toChartSeries(row.range, row.id)] : []));
  const timestamps = [...new Set(charts.flatMap((chart) => chart.timestamps))].sort(
    (a, b) => a - b,
  );
  const series = charts.flatMap((chart) =>
    chart.series.map((series) => {
      const values = new Map(chart.timestamps.map((time, index) => [time, series.values[index]]));
      return {
        ...series,
        label: queryCount > 1 ? series.label : series.label.slice(series.id.indexOf(':') + 2),
        values: timestamps.map((time) => values.get(time) ?? null),
      };
    }),
  );
  return { timestamps, series };
}

const finiteValue = (value: string) => {
  const parsed = parseSampleValue(value);
  return Number.isFinite(parsed) ? parsed : null;
};

export function instantRows(results: QueryResult[], queryCount: number) {
  return results.flatMap(({ id, instant }) => {
    if (!instant) return [];
    const prefix = queryCount > 1 ? `${id}: ` : '';
    if (instant.resultType === 'scalar' || instant.resultType === 'string')
      return [{ Series: `${prefix}scalar`, Value: finiteValue(instant.result[1]) }];
    if (instant.resultType === 'vector')
      return instant.result.map(({ metric, value }) => ({
        Series: `${prefix}${seriesLabel(metric, { keepName: true })}`,
        Value: finiteValue(value[1]),
      }));
    if (instant.resultType !== 'matrix') return [];
    return instant.result.map(({ metric, values }) => ({
      Series: `${prefix}${seriesLabel(metric, { keepName: true })}`,
      Value: values.length
        ? finiteValue(values.reduce((last, sample) => (sample[0] >= last[0] ? sample : last))[1])
        : null,
      Samples: values.length,
    }));
  });
}

export function rangeRows(results: QueryResult[], queryCount: number) {
  return chartResults(results, queryCount).series.map(({ label, values }) => {
    const summary = summarizeSeries(values);
    return {
      Series: label,
      Last: summary.last,
      Min: summary.min,
      Max: summary.max,
      Avg: summary.avg,
    };
  });
}
