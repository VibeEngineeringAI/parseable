import {
  autoStep,
  matcher,
  metricSelector,
  summarizeSeries,
  validateRange,
} from '../../lib/promql';
import { timeBounds } from '../../lib/query';
import { createId } from '../../lib/ids';
import type { PromqlQueryRequest, PromqlRangeRequest, TimeRange } from '../../lib/types';

export const maxQueries = 5;
export type QueryType = 'range' | 'instant' | 'both';
export type ExplorerState = {
  queries: string[];
  type: QueryType;
  step: string;
  range: TimeRange;
  rowIds?: string[];
  aliases?: string[];
};
export type Bounds = { start: number; end: number };
export type RunSnapshot = Bounds & {
  stream: string;
  type: QueryType;
  step: string;
  queries: Array<{ id: string; query: string; resolvedStep: string; alias?: string }>;
  rowOrder?: string[];
  aliases?: string[];
};
export type { QueryResult } from '../../lib/promqlResults';
import type { QueryResult } from '../../lib/promqlResults';
export { chartResults, instantRows } from '../../lib/promqlResults';
import { chartResults } from '../../lib/promqlResults';
export const queryId = (index: number) => String.fromCharCode(65 + index);

export function ensureRowIdentity(state: ExplorerState): ExplorerState {
  const rowIds = state.queries.map((_, index) => state.rowIds?.[index] ?? createId());
  const used = new Set(state.aliases ?? []);
  const aliases = state.queries.map((_, index) => {
    if (state.aliases?.[index] !== undefined) return state.aliases[index];
    let next = 0;
    while (used.has(queryId(next))) next++;
    const alias = queryId(next);
    used.add(alias);
    return alias;
  });
  return { ...state, rowIds, aliases };
}

// The picker's presets, and the classic quick ranges a classic link brings.
const urlPresets = ['10m', '15m', '30m', '1h', '5h', '6h', '24h', '3d', '7d'];

export function parseExplorerSearch(search: string): ExplorerState {
  const params = new URLSearchParams(search);
  const queries = params.getAll('query').slice(0, maxQueries);
  const type = params.get('type');
  const step = params.get('step') ?? '';
  let range: TimeRange = '1h';
  const preset = params.get('range');
  if (preset && urlPresets.includes(preset)) range = preset as TimeRange;
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
  const ids = params.getAll('qid').slice(0, maxQueries);
  const aliases = params.getAll('alias').slice(0, maxQueries);
  const rows = queries.length ? queries : [''];
  return {
    queries: rows,
    type: type === 'range' || type === 'instant' ? type : 'both',
    step: stepError(step) ? '' : step,
    range,
    ...(ids.length === rows.length &&
    ids.every((id) => /^[a-zA-Z0-9_-]{1,64}$/.test(id)) &&
    new Set(ids).size === ids.length
      ? { rowIds: ids }
      : {}),
    ...(aliases.length === rows.length
      ? { aliases: aliases.map((alias) => alias.slice(0, 80)) }
      : {}),
  };
}

export function serializeExplorerState(state: ExplorerState): string {
  const params = new URLSearchParams();
  for (const query of state.queries.slice(0, maxQueries)) params.append('query', query);
  state.rowIds?.slice(0, maxQueries).forEach((id) => params.append('qid', id));
  state.aliases?.slice(0, maxQueries).forEach((alias) => params.append('alias', alias));
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

export { boundsError, metadataRequest } from '../../lib/promqlMetadata';
import { boundsError } from '../../lib/promqlMetadata';

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
            id: state.rowIds?.[index] ?? queryId(index),
            ...(state.aliases ? { alias: state.aliases[index] } : {}),
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
      if (error) return { error: `${query.alias || query.id} · ${error}` };
    }
  }
  if (!queries.length) return { error: 'Enter a PromQL query to run.' };
  return {
    snapshot: {
      ...bounds,
      stream,
      type: state.type,
      step: state.step,
      queries,
      ...(state.rowIds ? { rowOrder: [...state.rowIds], aliases: [...(state.aliases ?? [])] } : {}),
    },
  };
}

export function snapshotState(snapshot: RunSnapshot, range: TimeRange): ExplorerState {
  if (snapshot.rowOrder) {
    const byId = new Map(snapshot.queries.map((row) => [row.id, row.query]));
    return {
      queries: snapshot.rowOrder.map((id) => byId.get(id) ?? ''),
      rowIds: [...snapshot.rowOrder],
      aliases: [...(snapshot.aliases ?? [])],
      type: snapshot.type,
      step: snapshot.step,
      range,
    };
  }
  // Preserve row IDs when some applied rows were empty.
  const queries = Array.from({ length: snapshot.queries.at(-1)!.id.charCodeAt(0) - 64 }, () => '');
  for (const row of snapshot.queries) queries[row.id.charCodeAt(0) - 65] = row.query;
  return { queries, type: snapshot.type, step: snapshot.step, range };
}

/**
 * Remove a stable identity from the executed row set, which may differ from the draft.
 * Numeric positions remain supported only for legacy positional snapshots.
 */
export function removeSnapshotQuery(
  snapshot: RunSnapshot,
  id: string | number,
): RunSnapshot | undefined {
  if (snapshot.rowOrder) {
    if (typeof id !== 'string') return snapshot;
    const index = snapshot.rowOrder.indexOf(id);
    if (index === -1) return snapshot;
    const removed = id;
    const queries = snapshot.queries.filter((row) => row.id !== removed);
    return queries.length
      ? {
          ...snapshot,
          queries,
          rowOrder: snapshot.rowOrder.filter((_, i) => i !== index),
          aliases: snapshot.aliases?.filter((_, i) => i !== index),
        }
      : undefined;
  }
  const index = typeof id === 'number' ? id : id.charCodeAt(0) - 65;
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
