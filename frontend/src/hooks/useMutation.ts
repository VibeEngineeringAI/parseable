import { useEffect, useRef, useState } from 'react';
import { errorMessage } from '../lib/errors';

// Runs one operation at a time and reports its failure; state updates stop after unmount.
export function useMutation() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const active = useRef(true);
  const running = useRef(false);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  async function run(operation: () => Promise<void>) {
    if (running.current) return;
    running.current = true;
    setPending(true);
    setError(undefined);
    try {
      await operation();
    } catch (failure) {
      if (active.current) setError(errorMessage(failure));
    } finally {
      running.current = false;
      if (active.current) setPending(false);
    }
  }
  return { pending, error, run, reset: () => setError(undefined), isActive: () => active.current };
}
