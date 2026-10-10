import { useState } from 'react';

/**
 * Keep an error only when its field has been touched (blurred), the form has had a submit attempt,
 * or the error is listed in `always` because the user did not type it (for example a capability gap).
 */
export function visibleErrors<K extends string>(
  errors: Partial<Record<K, string>>,
  touched: ReadonlySet<K>,
  attempted: boolean,
  always: readonly K[] = [],
): Partial<Record<K, string>> {
  const shown: Partial<Record<K, string>> = {};
  for (const key of Object.keys(errors) as K[])
    if (attempted || touched.has(key) || always.includes(key)) shown[key] = errors[key];
  return shown;
}

/**
 * Defers validation messages until a field has been touched or a submit was attempted. `attempts`
 * counts submit attempts so a form can move focus to the first invalid field after each one.
 */
export function useTouchedErrors<K extends string>(
  errors: Partial<Record<K, string>>,
  always: readonly K[] = [],
) {
  const [touched, setTouched] = useState<ReadonlySet<K>>(() => new Set());
  const [attempts, setAttempts] = useState(0);
  return {
    errors: visibleErrors(errors, touched, attempts > 0, always),
    attempts,
    touch: (key: K) =>
      setTouched((current) => (current.has(key) ? current : new Set(current).add(key))),
    attempt: () => setAttempts((count) => count + 1),
  };
}
