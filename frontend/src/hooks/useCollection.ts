import { useEffect, useState } from 'react';
import { useAsync } from './useAsync';

// Like useAsync, but keeps the previous result of the same loader visible while a reload runs,
// so row openers stay connected during refresh. Data never carries across loaders or errors.
export function useCollection<T>(loader: (signal: AbortSignal) => Promise<T>) {
  const result = useAsync(loader);
  const [previous, setPrevious] = useState<{ loader: typeof loader; data: T }>();
  useEffect(() => {
    if (result.error) setPrevious(undefined);
    else if (result.data !== undefined) setPrevious({ loader, data: result.data });
  }, [loader, result.data, result.error]);
  const data = result.error
    ? undefined
    : (result.data ?? (previous?.loader === loader ? previous.data : undefined));
  return { ...result, data };
}
