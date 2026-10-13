import { useEffect, useMemo, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { paramsRange, timeBounds } from './query';
import { appPath } from './config';
import type { TimeRange } from './types';

export type ObservabilityView = 'agents' | 'traces' | 'logs';
type Bounds = { startTime: string; endTime: string };
type Snapshot = { dataset: string; query: string };
type Context = {
  version: 1;
  bounds: Bounds;
  range: TimeRange;
  views: Partial<Record<ObservabilityView, Snapshot>>;
};
const contextKey = 'observe';
const views: ObservabilityView[] = ['agents', 'traces', 'logs'];
const maxLength = 200_000;

export function currentObservabilitySearch(pathname: string, fallback: string): string {
  return typeof window !== 'undefined' && window.location.pathname === appPath(pathname)
    ? window.location.search
    : fallback;
}

export function observabilityView(pathname: string): ObservabilityView | undefined {
  return views.find((view) => pathname === `/${view}` || pathname.startsWith(`/${view}/`));
}
function context(params: URLSearchParams): Context | undefined {
  const raw = params.get(contextKey);
  if (!raw || raw.length > maxLength) return;
  try {
    const value = JSON.parse(raw) as Context;
    if (value.version !== 1 || !value.views || typeof value.views !== 'object') return;
    const bounds = timeBounds(value.bounds);
    timeBounds(value.range);
    const snapshots: Context['views'] = {};
    for (const view of views) {
      const snapshot = value.views[view];
      if (!snapshot) continue;
      if (
        typeof snapshot.dataset !== 'string' ||
        snapshot.dataset.length > 512 ||
        typeof snapshot.query !== 'string' ||
        snapshot.query.length > maxLength
      )
        return;
      snapshots[view] = snapshot;
    }
    return { version: 1, bounds, range: value.range, views: snapshots };
  } catch {
    return;
  }
}

export function observabilitySnapshot(
  params: URLSearchParams,
  view: ObservabilityView,
): Snapshot | undefined {
  return context(params)?.views[view];
}

/** Presets retain their picker label while explicit bounds freeze the handoff's query window. */
export function observabilityRange(params: URLSearchParams): TimeRange {
  const preset = params.get('range');
  if (preset) {
    try {
      timeBounds(preset as TimeRange);
      return preset as TimeRange;
    } catch {
      /* Ignore malformed presets. */
    }
  }
  if (params.has('start') || params.has('end')) return paramsRange(params);
  return context(params)?.range ?? '1h';
}
export function observabilityBounds(params: URLSearchParams, range: TimeRange): Bounds {
  if (params.has('start') && params.has('end')) {
    try {
      return timeBounds({ startTime: params.get('start')!, endTime: params.get('end')! });
    } catch {
      /* Ignore malformed handoff bounds. */
    }
  }
  return context(params)?.bounds ?? timeBounds(range);
}
function nativeParams(params: URLSearchParams) {
  const next = new URLSearchParams(params);
  next.delete(contextKey);
  next.delete('from');
  // Setup is a transient panel, not an explorer filter to restore on a handoff.
  next.delete('setup');
  return next;
}
export function captureObservability(
  params: URLSearchParams,
  options: {
    view: ObservabilityView;
    dataset: string;
    range: TimeRange;
    bounds: Bounds;
    query?: URLSearchParams;
  },
): URLSearchParams {
  const next = new URLSearchParams(params);
  const current = context(params);
  const state: Context = {
    version: 1,
    bounds: timeBounds(options.bounds),
    range: options.range,
    views: {
      ...current?.views,
      [options.view]: {
        dataset: options.dataset,
        query: nativeParams(options.query ?? params).toString(),
      },
    },
  };
  if (options.view !== 'logs') {
    next.set('start', state.bounds.startTime);
    next.set('end', state.bounds.endTime);
    if (typeof state.range === 'string') next.set('range', state.range);
    else next.delete('range');
  }
  next.set(contextKey, JSON.stringify(state));
  return next;
}
export function observabilityHref(
  source: { pathname: string; search: string },
  target: ObservabilityView,
  options: { dataset?: string; traceId?: string } = {},
): string {
  const params = new URLSearchParams(source.search);
  const state = context(params);
  const sourceView = observabilityView(source.pathname);
  let sourceDataset: string | undefined;
  try {
    const segments = source.pathname.split('/').filter(Boolean);
    const encoded = sourceView === 'agents' ? segments[1] : segments[2];
    if (encoded) sourceDataset = decodeURIComponent(encoded);
  } catch {
    /* A malformed path falls back to remembered datasets. */
  }
  // Capture URL-owned edits synchronously, including a click before the saving effect runs.
  if (state && sourceView && sourceView !== 'logs') {
    state.views[sourceView] = {
      dataset: sourceDataset ?? state.views[sourceView]?.dataset ?? '',
      query: nativeParams(params).toString(),
    };
    state.range = observabilityRange(params);
    state.bounds = observabilityBounds(params, state.range);
  }
  const remembered = state?.views[target];
  const dataset =
    options.dataset ??
    remembered?.dataset ??
    sourceDataset ??
    state?.views[sourceView ?? target]?.dataset;
  const sameDataset = !options.dataset || remembered?.dataset === options.dataset;
  const next = new URLSearchParams(sameDataset ? remembered?.query : undefined);
  if (state) {
    next.set('start', state.bounds.startTime);
    next.set('end', state.bounds.endTime);
    if (typeof state.range === 'string') next.set('range', state.range);
    else next.delete('range');
    next.set(contextKey, JSON.stringify(state));
  }
  if (options.traceId && /^[a-fA-F0-9]{32}$/.test(options.traceId))
    next.set('traceId', options.traceId);
  const path = dataset
    ? target === 'agents'
      ? `/agents/${encodeURIComponent(dataset)}`
      : `/${target}/explore/${encodeURIComponent(dataset)}`
    : `/${target}`;
  return `${path}${next.size ? `?${next}` : ''}`;
}

/** Persist each view's own filters rather than interpreting another view's filter schema. */
export function useObservabilityNavigation(options: {
  view: ObservabilityView;
  dataset?: string;
  range: TimeRange;
  bounds: Bounds;
  params?: URLSearchParams;
  query?: URLSearchParams;
  enabled?: boolean;
}) {
  const location = useLocation();
  const navigate = useNavigate();
  const browserRouter = useRef(
    typeof window !== 'undefined' && window.location.pathname === appPath(location.pathname),
  );
  const currentSearch = options.params?.toString() ?? location.search;
  const query = options.query?.toString();
  const rangeKey = JSON.stringify(options.range);
  const captured = useMemo(
    () =>
      captureObservability(new URLSearchParams(currentSearch), {
        view: options.view,
        dataset: options.dataset ?? '',
        range: JSON.parse(rangeKey) as TimeRange,
        bounds: options.bounds,
        query: query === undefined ? undefined : new URLSearchParams(query),
      }),
    [
      currentSearch,
      options.view,
      options.dataset,
      rangeKey,
      options.bounds.startTime,
      options.bounds.endTime,
      query,
    ],
  );
  const search = captured.toString();
  useEffect(() => {
    // Browser history updates synchronously; an older capture effect must not overwrite a newer navigation.
    if (
      browserRouter.current &&
      (window.location.pathname !== appPath(location.pathname) ||
        window.location.search !== location.search)
    )
      return;
    if (options.enabled === false || new URLSearchParams(location.search).toString() === search)
      return;
    navigate(
      { pathname: location.pathname, search, hash: location.hash },
      { replace: true, state: location.state },
    );
  }, [search, options.enabled, location, navigate]);
  return {
    href: (target: ObservabilityView, targetOptions?: { dataset?: string; traceId?: string }) =>
      observabilityHref({ pathname: location.pathname, search }, target, targetOptions),
  };
}
