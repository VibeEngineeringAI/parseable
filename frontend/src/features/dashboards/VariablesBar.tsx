import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActionsMenu, Button, Input, Select } from '../../components/ui';
import { QueryState } from '../../components/explorer/QueryState';
import { useApp } from '../../app/AppProvider';
import { useAsync } from '../../hooks/useAsync';
import type { DashboardVariable, QueryRequest } from '../../lib/types';
import {
  allValue,
  defaultSelection,
  loadVariableOptions,
  variableInputs,
  type VariableValues,
} from './variables';

export function VariablesBar({
  variables,
  values,
  params,
  bounds,
  writable,
  promqlEnabled,
  onSelect,
  onReady,
  onEdit,
  onDelete,
  onAdd,
}: {
  variables: DashboardVariable[];
  values: VariableValues;
  params: URLSearchParams;
  bounds: Omit<QueryRequest, 'sql'>;
  writable: boolean;
  promqlEnabled: boolean;
  onSelect: (name: string, value: string) => void;
  onReady: (ready: Record<string, boolean>) => void;
  onEdit: (variable: DashboardVariable) => void;
  onDelete: (variable: DashboardVariable) => void;
  onAdd: () => void;
}) {
  const [ready, setReady] = useState<Record<string, boolean>>({});
  useEffect(() => onReady(ready), [ready, onReady]);
  const resolved = useCallback(
    (name: string, value: boolean) =>
      setReady((current) => (current[name] === value ? current : { ...current, [name]: value })),
    [],
  );
  return (
    <div className="dashboard-variables" role="region" aria-label="Dashboard variables">
      {variables.map((variable) => (
        <VariableControl
          key={variable.name}
          variable={variable}
          variables={variables}
          values={values}
          selected={params.get(`var-${variable.name}`)}
          bounds={bounds}
          promqlEnabled={promqlEnabled}
          onSelect={onSelect}
          onReady={resolved}
          actions={
            writable ? (
              <ActionsMenu
                label={`Actions for variable ${variable.label}`}
                items={[
                  { id: 'edit', label: 'Edit variable', onSelect: () => onEdit(variable) },
                  {
                    id: 'delete',
                    label: 'Delete variable',
                    destructive: true,
                    onSelect: () => onDelete(variable),
                  },
                ]}
              />
            ) : undefined
          }
        />
      ))}
      {writable && (
        <Button size="sm" onClick={onAdd}>
          Add variable
        </Button>
      )}
    </div>
  );
}
function VariableControl({
  variable,
  variables,
  values,
  selected,
  bounds,
  promqlEnabled,
  onSelect,
  onReady,
  actions,
}: {
  variable: DashboardVariable;
  variables: DashboardVariable[];
  values: VariableValues;
  selected: string | null;
  bounds: Omit<QueryRequest, 'sql'>;
  promqlEnabled: boolean;
  onSelect: (name: string, value: string) => void;
  onReady: (name: string, ready: boolean) => void;
  actions?: React.ReactNode;
}) {
  const { client } = useApp();
  const inputKey = JSON.stringify(variableInputs(variable, values));
  const inputs = useMemo(() => JSON.parse(inputKey) as VariableValues, [inputKey]);
  const source = [
    variable.dataset,
    variable.sqlQuery,
    variable.promqlQuery,
    variable.promqlQueryDataset,
    ...(variable.labelFilters ?? []).map((filter) => filter.value),
  ].join(' ');
  const dependencies = [...source.matchAll(/\$\{?(\w+)\}?/g)].map((match) => match[1]);
  const pendingDependencies = dependencies.some(
    (name) => inputs[name] === undefined || inputs[name] === '',
  );
  const locked = !promqlEnabled && ['promql', 'promql_query'].includes(variable.type);
  const options = useAsync(
    useCallback(
      (signal) =>
        locked || pendingDependencies
          ? Promise.resolve(undefined)
          : loadVariableOptions(client, variable, inputs, variables, bounds, signal),
      [
        client,
        variable,
        inputKey,
        JSON.stringify(variables),
        bounds.startTime,
        bounds.endTime,
        locked,
        pendingDependencies,
      ],
    ),
  );
  const value =
    variable.type === 'text'
      ? (selected ?? variable.defaultValue ?? '')
      : defaultSelection(variable, options.data ?? [], selected);
  useEffect(() => {
    onReady(variable.name, !options.loading && !pendingDependencies && !locked && !options.error);
    if (
      !options.loading &&
      !options.error &&
      !locked &&
      !pendingDependencies &&
      (variable.type === 'text' || options.data?.length) &&
      value !== selected
    )
      onSelect(variable.name, value);
  }, [
    variable.name,
    variable.type,
    options.data,
    options.loading,
    options.error,
    value,
    selected,
    pendingDependencies,
    locked,
    onReady,
    onSelect,
  ]);
  return (
    <div className="dashboard-variable">
      <div className="dashboard-variable-control">
        {variable.type === 'text' ? (
          <Input
            label={variable.label}
            value={value}
            onChange={(event) => onSelect(variable.name, event.target.value)}
          />
        ) : (
          <Select
            label={variable.label}
            value={value}
            disabled={options.loading || locked || pendingDependencies || !options.data?.length}
            onChange={(event) => onSelect(variable.name, event.target.value)}
          >
            {!options.data?.length && (
              <option value="">
                {options.loading
                  ? 'Loading…'
                  : pendingDependencies
                    ? 'Select dependent variables'
                    : 'No values'}
              </option>
            )}
            {options.data?.map((value) => (
              <option key={value} value={value}>
                {variable.includeAll && value === allValue(variable) ? 'All' : value}
              </option>
            ))}
          </Select>
        )}
        {actions}
      </div>
      {locked && <p className="muted">PromQL variables are unavailable on this server.</p>}
      <QueryState loading={false} error={options.error} retry={options.reload} />
    </div>
  );
}
