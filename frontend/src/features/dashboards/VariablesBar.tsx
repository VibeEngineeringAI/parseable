import { useCallback } from 'react';
import { ActionsMenu } from '../../components/ui';
import type { DashboardVariable, QueryRequest } from '../../lib/types';
import type { VariableValues } from './variables';
import {
  VariableControl,
  type VariableResolution,
  type VariableResolutions,
} from './VariableControl';

export function VariablesBar({
  variables,
  values,
  params,
  bounds,
  writable,
  promqlEnabled,
  resolutions,
  onSelect,
  onResolve,
  onEdit,
  onDelete,
}: {
  variables: DashboardVariable[];
  values: VariableValues;
  params: URLSearchParams;
  bounds: Omit<QueryRequest, 'sql'>;
  writable: boolean;
  promqlEnabled?: boolean;
  resolutions: VariableResolutions;
  onSelect: (name: string, value: string) => void;
  onResolve: React.Dispatch<React.SetStateAction<VariableResolutions>>;
  onEdit: (variable: DashboardVariable) => void;
  onDelete: (variable: DashboardVariable) => void;
}) {
  const resolved = useCallback(
    (name: string, result: VariableResolution) =>
      onResolve((current) =>
        JSON.stringify(current[name]) === JSON.stringify(result)
          ? current
          : { ...current, [name]: result },
      ),
    [onResolve],
  );
  if (!variables.length) return null;
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
          resolutions={resolutions}
          onSelect={onSelect}
          onResolve={resolved}
          actions={
            writable ? (
              <ActionsMenu
                label={`Actions for variable ${variable.label}`}
                data-row-action={variable.name}
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
    </div>
  );
}
