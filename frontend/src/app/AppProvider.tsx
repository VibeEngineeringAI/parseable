import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { ApiError, createClient } from '../lib/client';
import { clearSessionCookies } from '../lib/auth';
import { demoEnabled } from '../lib/config';
import type { SessionIdentity } from '../lib/types';
export type Mode = 'demo' | 'live';
const Context = createContext<ReturnType<typeof useAppState> | null>(null);
function useAppState() {
  const [mode, setModeState] = useState<Mode>(() => {
    if (demoEnabled && sessionStorage.getItem('parseable-mode') === 'demo') return 'demo';
    sessionStorage.removeItem('parseable-mode');
    return 'live';
  });
  const [session, setSession] = useState(0);
  const [needsLogin, setNeedsLogin] = useState(false);
  const [identity, setIdentity] = useState<SessionIdentity>();
  const requireLogin = useCallback(() => {
    clearSessionCookies();
    setIdentity(undefined);
    setNeedsLogin(true);
  }, []);
  const client = useMemo(
    () => createClient({ mode, onUnauthorized: requireLogin }),
    [mode, session, requireLogin],
  );
  useEffect(() => {
    const controller = new AbortController();
    client
      .identity(controller.signal)
      .then(async (value) => {
        // Pages with only local content still need expiry recovery. A profile
        // response proves a server session; cookie display hints do not.
        if (mode === 'live' && value?.source !== 'server') {
          try {
            await client.listDatasets(controller.signal);
          } catch (error) {
            // The client reports 401 centrally. Other errors belong to the page.
            if (error instanceof ApiError && error.status === 401) return;
          }
        }
        if (!controller.signal.aborted) setIdentity(value);
      })
      .catch(() => {
        /* Identity is optional; data request errors remain visible. */
      });
    return () => controller.abort();
  }, [client, mode]);
  const setMode = (value: Mode) => {
    const allowedMode = value === 'demo' && demoEnabled ? 'demo' : 'live';
    sessionStorage.setItem('parseable-mode', allowedMode);
    setModeState(allowedMode);
    setIdentity(undefined);
    setNeedsLogin(false);
    setSession((s) => s + 1);
  };
  return { mode, setMode, client, session, identity, needsLogin, demoEnabled };
}
export function AppProvider({ children }: { children: ReactNode }) {
  return <Context.Provider value={useAppState()}>{children}</Context.Provider>;
}
export function useApp() {
  const ctx = useContext(Context);
  if (!ctx) throw new Error('Missing AppProvider');
  return ctx;
}
