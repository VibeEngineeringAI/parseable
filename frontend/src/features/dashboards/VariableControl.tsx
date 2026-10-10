import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Button, Input, Select } from '../../components/ui';
import { useApp } from '../../app/AppProvider';
import { useAsync } from '../../hooks/useAsync';
import type { DashboardVariable, QueryRequest } from '../../lib/types';
import {
  allValue,
  defaultSelection,
  loadVariableOptions,
  variableDependencies,
  variableInputs,
  variableOptionsDefinition,
  type VariableValues,
} from './variables';

export type VariableResolution = { value: string; ready: boolean; error?: string };
export type VariableResolutions = Record<string, VariableResolution>;

function TextValue({
  label,
  value,
  commit,
}: {
  label: string;
  value: string;
  commit: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const lastSent = useRef(value);
  useEffect(() => {
    if (value !== lastSent.current) {
      setDraft(value);
      lastSent.current = value;
    }
  }, [value]);
  const send = useCallback(
    (next: string) => {
      lastSent.current = next;
      commit(next);
    },
    [commit],
  );
  useEffect(() => {
    if (draft === value) return;
    const timer = setTimeout(() => send(draft), 400);
    return () => clearTimeout(timer);
  }, [draft, value, send]);
  return (
    <Input
      label={label}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        if (draft !== value) send(draft);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          if (draft !== value) send(draft);
        }
      }}
    />
  );
}
export function VariableControl({
  variable,
  variables,
  values,
  selected,
  bounds,
  promqlEnabled,
  resolutions,
  onSelect,
  onResolve,
  actions,
}: {
  variable: DashboardVariable;
  variables: DashboardVariable[];
  values: VariableValues;
  selected: string | null;
  bounds: Omit<QueryRequest, 'sql'>;
  promqlEnabled?: boolean;
  resolutions: VariableResolutions;
  onSelect: (name: string, value: string) => void;
  onResolve: (name: string, result: VariableResolution) => void;
  actions?: ReactNode;
}) {
  const { client } = useApp(),
    errorId = useId();
  const dependencies = variableDependencies(variable);
  const upstreamError = dependencies.map((name) => resolutions[name]?.error).find(Boolean);
  const pendingDependencies = dependencies.some(
    (name) => !resolutions[name]?.ready || resolutions[name]?.value !== values[name],
  );
  const promql = ['promql', 'promql_query'].includes(variable.type);
  const locked = promql && promqlEnabled !== true;
  const dynamic = ['sql', 'promql', 'promql_query'].includes(variable.type);
  const definition = variableOptionsDefinition(variable);
  const sourceKey = JSON.stringify({
    definition,
    inputs: variableInputs(variable, values),
    datasetVariables: variables
      .filter((row) => dependencies.includes(row.name) && row.type === 'dataset')
      .map((row) => row.name),
    bounds: dynamic ? bounds : undefined,
    locked,
    pendingDependencies,
  });
  // Loader identity follows content used by the request, never the document's identity.
  const options = useAsync(
    useCallback(
      (signal) =>
        locked || pendingDependencies
          ? Promise.resolve(undefined)
          : loadVariableOptions(
              client,
              variable,
              variableInputs(variable, values),
              variables,
              bounds,
              signal,
            ),
      [client, sourceKey],
    ),
  );
  const [previous, setPrevious] = useState<{ key: string; options: string[] }>();
  const definitionKey = JSON.stringify({
    definition: { ...definition, includeAll: undefined },
    inputs: variableInputs(variable, values),
  });
  useEffect(() => {
    if (options.data) setPrevious({ key: definitionKey, options: options.data });
  }, [options.data, definitionKey]);
  // Revalidating a range retains a valid selection and doesn't abort tile queries.
  const choices = options.data ?? (previous?.key === definitionKey ? previous.options : undefined);
  const value = defaultSelection(variable, choices ?? [], selected);
  const available = variable.type === 'text' || !!choices?.length;
  const ready =
    !locked && !pendingDependencies && !options.error && available && value === selected;
  useEffect(() => {
    onResolve(variable.name, {
      value,
      ready,
      error: options.error?.message ?? upstreamError,
    });
    if (available && !locked && !pendingDependencies && !options.error && selected !== value)
      onSelect(variable.name, value);
  }, [
    variable.name,
    value,
    ready,
    options.error,
    upstreamError,
    available,
    locked,
    pendingDependencies,
    selected,
    onResolve,
    onSelect,
  ]);
  const commit = useCallback(
    (value: string) => onSelect(variable.name, value),
    [onSelect, variable.name],
  );
  return (
    <div className="dashboard-variable">
      <div className="dashboard-variable-control">
        {variable.type === 'text' ? (
          <TextValue
            label={variable.label}
            value={selected ?? variable.defaultValue ?? ''}
            commit={commit}
          />
        ) : (
          <Select
            label={variable.label}
            value={value}
            aria-describedby={options.error ? errorId : undefined}
            disabled={locked || pendingDependencies || !choices?.length}
            aria-busy={options.loading}
            onChange={(event) => onSelect(variable.name, event.target.value)}
          >
            {!choices?.length && (
              <option value="">
                {options.loading || (promql && promqlEnabled === undefined)
                  ? 'Loading…'
                  : pendingDependencies
                    ? 'Waiting for dependent variables'
                    : 'No values'}
              </option>
            )}
            {choices?.map((value) => (
              <option key={value} value={value}>
                {variable.includeAll && value === allValue(variable) ? 'All' : value}
              </option>
            ))}
          </Select>
        )}
        {actions}
      </div>
      {promql && promqlEnabled === false && (
        <p className="muted">PromQL variables are unavailable on this server.</p>
      )}
      {options.error && (
        <p id={errorId} className="error-text dashboard-variable-error">
          Could not load values for {variable.label}: {options.error.message}{' '}
          <Button size="sm" onClick={options.reload}>
            Retry {variable.label}
          </Button>
        </p>
      )}
    </div>
  );
}
