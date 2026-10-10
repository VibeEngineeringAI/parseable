import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { timeBounds } from '../../lib/query';
import type { Dashboard, TimeRange } from '../../lib/types';
import { dashboardRange, rangeParams } from './timeRange';
import { readVariables, type VariableValues } from './variables';

export function useDashboardUrl(draft: Dashboard) {
  const [params, setParams] = useSearchParams();
  const paramsRef = useRef(params),
    committed = useRef(params.toString());
  // An urgent render during router navigation still has the old params. Only a
  // committed URL change replaces the merge base for simultaneous defaults.
  if (committed.current !== params.toString()) {
    committed.current = params.toString();
    paramsRef.current = params;
  }
  const updateParams = useCallback(
    (edit: (current: URLSearchParams) => URLSearchParams) => {
      const next = edit(new URLSearchParams(paramsRef.current));
      paramsRef.current = next;
      setParams(next, { replace: true });
    },
    [setParams],
  );
  const range = dashboardRange(params, draft.timeRange);
  const rangeKey = JSON.stringify(range);
  const [revision, setRevision] = useState(0);
  // Query inputs derive entirely from committed URL state. Refresh changes the
  // anchor and revision together. Relative ranges otherwise hold like classic.
  const anchor = useMemo(() => Date.now(), [rangeKey, revision]);
  const bounds = useMemo(() => timeBounds(range, anchor), [rangeKey, anchor]);
  useEffect(() => {
    if (
      !paramsRef.current.has('range') &&
      !(paramsRef.current.has('start') && paramsRef.current.has('end'))
    )
      updateParams((current) => rangeParams(current, range));
  }, [rangeKey, updateParams]);
  const variables = useMemo(() => readVariables(draft.variables), [draft.variables]);
  const values = useMemo<VariableValues>(
    () =>
      Object.fromEntries(
        variables.flatMap((variable) => {
          const value = params.get(`var-${variable.name}`);
          return value === null ? [] : [[variable.name, value]];
        }),
      ),
    [variables, params],
  );
  const select = useCallback(
    (name: string, value: string) =>
      updateParams((current) => {
        current.set(`var-${name}`, value);
        return current;
      }),
    [updateParams],
  );
  const setRange = (value: TimeRange) => updateParams((current) => rangeParams(current, value));
  return {
    params,
    range,
    variables,
    values,
    select,
    setRange,
    bounds,
    anchor,
    revision,
    refresh: () => setRevision((value) => value + 1),
  };
}
