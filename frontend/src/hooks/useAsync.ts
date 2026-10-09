import { useEffect, useState } from 'react';
// Callers memoize the loader: replacing it cancels the previous request.
export function useAsync<T>(loader: (signal: AbortSignal) => Promise<T>) {
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
          setState({
            error: error instanceof Error ? error : new Error(String(error)),
            loader,
            revision,
          });
      });
    return () => abort.abort();
  }, [loader, revision]);
  const current = state.loader === loader && state.revision === revision;
  return {
    data: current ? state.data : undefined,
    error: current ? state.error : undefined,
    loading: !current,
    reload: () => setRevision((v) => v + 1),
  };
}
