import { useCallback, useEffect, useRef } from 'react';
import { useBlocker } from 'react-router-dom';

// The router restores browser history while a blocked navigation awaits confirmation.
export function useLeaveGuard(dirty: boolean, resource = 'alert') {
  const changed = useRef(dirty);
  changed.current = dirty;
  const blocker = useBlocker(
    useCallback(
      ({ currentLocation, nextLocation }) =>
        changed.current &&
        currentLocation.pathname !== nextLocation.pathname &&
        !nextLocation.pathname.startsWith('/login'),
      [],
    ),
  );
  useEffect(() => {
    if (blocker.state === 'blocked') {
      if (window.confirm(`Leave without saving this ${resource}?`)) blocker.proceed();
      else blocker.reset();
    }
  }, [blocker, resource]);
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (changed.current) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, []);
  return () => {
    changed.current = false;
  };
}
