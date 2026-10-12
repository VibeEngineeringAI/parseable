import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Button, Select } from '../../components/ui';
import { useAsync } from '../../hooks/useAsync';
import { withQueryTimeout } from './queryTimeout';

export const refreshIntervals = [
  { value: 0, label: 'Off' },
  { value: 15_000, label: '15s' },
  { value: 30_000, label: '30s' },
  { value: 60_000, label: '1m' },
  { value: 300_000, label: '5m' },
];

type Tracker = {
  track: <T>(
    id: string,
    kind: 'tile' | 'variable',
    loader: (signal: AbortSignal) => Promise<T>,
    signal: AbortSignal,
  ) => Promise<T>;
  forget: (id: string) => void;
};
const Queries = createContext<Tracker | undefined>(undefined);
const Refresh = createContext<
  | {
      interval: number;
      setRefreshInterval: (value: number) => void;
      busy: boolean;
      hidden: boolean;
      failed: boolean;
      lastUpdated?: number;
      refresh: () => boolean;
    }
  | undefined
>(undefined);

/** One completion-based timer for the whole view, including variable queries. */
export function DashboardRefreshProvider({
  onRefresh,
  children,
}: {
  onRefresh: () => void;
  children: ReactNode;
}) {
  const [interval, setRefreshInterval] = useState(0);
  const [hidden, setHidden] = useState(() => document.hidden);
  const [activity, setActivity] = useState(0);
  const [lastUpdated, setLastUpdated] = useState<number>();
  const pending = useRef(new Set<symbol>());
  const failures = useRef(new Set<string>());
  const launching = useRef(false);
  const publish = useCallback(() => setActivity((value) => value + 1), []);
  const tracker = useMemo<Tracker>(
    () => ({
      async track(id, kind, loader, signal) {
        const token = Symbol();
        pending.current.add(token);
        publish();
        try {
          const value = await loader(signal);
          if (!signal.aborted && value !== undefined) {
            failures.current.delete(id);
            // Variable options and skipped queries are not fresh chart data.
            if (kind === 'tile') setLastUpdated(Date.now());
          }
          return value;
        } catch (error) {
          if (!signal.aborted) failures.current.add(id);
          throw error;
        } finally {
          pending.current.delete(token);
          publish();
        }
      },
      forget(id) {
        failures.current.delete(id);
        publish();
      },
    }),
    [publish],
  );
  const refresh = useCallback(() => {
    // Read refs and visibility at dispatch time as well as disabling the button.
    if (pending.current.size || launching.current || document.hidden) return false;
    launching.current = true;
    onRefresh();
    publish();
    return true;
  }, [onRefresh, publish]);
  useEffect(() => {
    launching.current = false;
  }, [activity]);
  useEffect(() => {
    const changed = () => setHidden(document.hidden);
    document.addEventListener('visibilitychange', changed);
    return () => document.removeEventListener('visibilitychange', changed);
  }, []);
  useEffect(() => {
    if (!interval || hidden || pending.current.size) return;
    // Start a fresh interval after completion, interval changes, or returning
    // to the tab. Never catch up missed ticks with a burst of requests.
    const timer = setTimeout(refresh, interval);
    return () => clearTimeout(timer);
  }, [interval, hidden, activity, refresh]);
  return (
    <Queries.Provider value={tracker}>
      <Refresh.Provider
        value={{
          interval,
          setRefreshInterval,
          busy: pending.current.size > 0,
          hidden,
          failed: failures.current.size > 0,
          lastUpdated,
          refresh,
        }}
      >
        {children}
      </Refresh.Provider>
    </Queries.Provider>
  );
}

/** Track actual promises through settlement, including cancellation. */
export function useDashboardQuery<T>(
  loader: (signal: AbortSignal) => Promise<T>,
  { kind = 'tile', key, scope }: { kind?: 'tile' | 'variable'; key?: string; scope?: unknown } = {},
) {
  const tracker = useContext(Queries);
  const id = useId();
  // Serialize replacement loaders even if a transport takes time to honor abort.
  const tail = useRef<Promise<unknown>>(Promise.resolve());
  const tracked = useCallback(
    (signal: AbortSignal) => {
      const run = async () => {
        await tail.current.catch(() => undefined);
        signal.throwIfAborted();
        // Tile requests start their individual timeouts after leaving the
        // limiter queue. Variable requests have no queue.
        return kind === 'variable' ? withQueryTimeout(loader, signal) : loader(signal);
      };
      const operation = tracker ? tracker.track(id, kind, run, signal) : run();
      tail.current = operation;
      return operation;
    },
    [loader, tracker, id, kind],
  );
  // A failure belongs to its query definition and client, not to the mounted
  // control forever. Rolling refreshes keep these keys stable.
  useEffect(() => () => tracker?.forget(id), [tracker, id, key, scope]);
  return useAsync(tracked);
}

export function DashboardRefreshControls({ onManualRefresh }: { onManualRefresh?: () => void }) {
  const state = useContext(Refresh);
  const [announcement, setAnnouncement] = useState('');
  const previouslyFailed = useRef(false);
  const failed = state?.failed ?? false;
  useEffect(() => {
    if (failed) setAnnouncement('Refresh failed. Last successful data is kept where available.');
    else if (previouslyFailed.current) setAnnouncement('Refresh recovered.');
    previouslyFailed.current = failed;
  }, [failed]);
  if (!state) throw new Error('Missing DashboardRefreshProvider');
  return (
    <>
      <Select
        label="Auto refresh"
        value={state.interval}
        onChange={(event) => state.setRefreshInterval(Number(event.target.value))}
      >
        {refreshIntervals.map(({ value, label }) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </Select>
      <Button
        className="dashboard-refresh-button"
        aria-disabled={state.busy || state.hidden}
        onClick={() => {
          if (state.refresh()) onManualRefresh?.();
        }}
      >
        Refresh
      </Button>
      <div className="dashboard-refresh-status">
        <span className="muted">
          Last updated:{' '}
          {state.lastUpdated ? (
            <time
              dateTime={new Date(state.lastUpdated).toISOString()}
              title={new Date(state.lastUpdated).toLocaleString()}
            >
              {new Date(state.lastUpdated).toLocaleTimeString()}
            </time>
          ) : (
            'Never'
          )}
        </span>
        {state.busy && <span className="muted">Refreshing…</span>}
        {state.interval > 0 && state.hidden && (
          <span className="muted">Auto refresh paused while tab is hidden.</span>
        )}
        <span
          className={state.failed ? 'error-text' : 'muted'}
          aria-live="polite"
          aria-atomic="true"
        >
          {announcement}
        </span>
      </div>
    </>
  );
}
