import { useEffect, useState } from 'react';
// Callers memoize the loader: replacing it cancels the previous request.
export function useAsync<T>(
  loader: (signal: AbortSignal) => Promise<T>,
  { keepPreviousData = false }: { keepPreviousData?: boolean } = {},
) {
  const [revision, setRevision] = useState(0);
  // Tagged with the request it answers, so a result never outlives its loader:
  // until the new request's effect runs, the stale result reads as loading.
  const [state, setState] = useState<{
    data?: T;
    error?: Error;
    loader?: typeof loader;
    revision?: number;
  }>({});
  useEffect(() => {
    const abort = new AbortController();
    loader(abort.signal)
      .then((data) => {
        if (!abort.signal.aborted) setState({ data, loader, revision });
      })
      .catch((error) => {
        if (!abort.signal.aborted)
          setState((previous) => ({
            data: keepPreviousData && previous.loader === loader ? previous.data : undefined,
            error: error instanceof Error ? error : new Error(String(error)),
            loader,
            revision,
          }));
      });
    return () => abort.abort();
  }, [loader, revision, keepPreviousData]);
  const current = state.loader === loader && state.revision === revision;
  return {
    // Retention is opt-in and limited to reloads of the same loader, so a
    // changed dataset/client never exposes the previous request's data.
    data: current || (keepPreviousData && state.loader === loader) ? state.data : undefined,
    error: current ? state.error : undefined,
    loading: !current,
    reload: () => setRevision((v) => v + 1),
  };
}
