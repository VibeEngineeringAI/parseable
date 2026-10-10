import { useId, useState } from 'react';
import { Button, Dialog, Input, Select } from '../../components/ui';
import { SqlEditor } from '../sql/SqlEditor';
import { PromqlEditor } from '../../components/promql/PromqlEditor';
import { createId } from '../../lib/ids';
import type { DashboardVariable } from '../../lib/types';
import { serializeVariable, setVariableType, variableDependencyError } from './variables';
const types: Array<[DashboardVariable['type'], string]> = [
  ['promql', 'PromQL label values'],
  ['promql_query', 'PromQL query'],
  ['sql', 'SQL query'],
  ['list', 'List'],
  ['text', 'Text'],
  ['dataset', 'Dataset'],
];
export function VariableEditor({
  original,
  variables,
  datasets,
  promqlEnabled,
  onClose,
  onApply,
  onDirty,
}: {
  original?: DashboardVariable;
  variables: DashboardVariable[];
  datasets: string[];
  promqlEnabled?: boolean;
  onClose: () => void;
  onApply: (variable: DashboardVariable) => void;
  onDirty: (dirty: boolean) => void;
}) {
  const [draft, setDraft] = useState<DashboardVariable>(() =>
    structuredClone(original ?? { name: '', label: '', type: 'list' }),
  );
  const [filterIds, setFilterIds] = useState(() =>
    (draft.labelFilters ?? []).map(() => createId()),
  );
  const reason = useId(),
    optionsId = useId(),
    allId = useId();
  const [optionsText, setOptionsText] = useState((draft.options ?? []).join(', '));
  function change(edits: Partial<DashboardVariable>) {
    setDraft((current) => ({ ...current, ...edits }));
    onDirty(true);
  }
  const choices = [
    ...new Set([
      ...datasets,
      ...variables
        .filter((variable) => variable.type === 'dataset' && variable.name !== draft.name)
        .map((variable) => `$${variable.name}`),
      ...(draft.dataset ? [draft.dataset] : []),
      ...(draft.promqlQueryDataset ? [draft.promqlQueryDataset] : []),
    ]),
  ];
  const validation = !/^\w+$/.test(draft.name)
    ? 'Use letters, numbers and underscores for the variable name.'
    : variables.some((variable) => variable.name === draft.name && variable.name !== original?.name)
      ? 'Variable names must be unique.'
      : !draft.label.trim()
        ? 'Enter a variable label.'
        : ['promql', 'promql_query'].includes(draft.type) && !promqlEnabled
          ? promqlEnabled === undefined
            ? 'Loading server capabilities…'
            : 'PromQL variables are unavailable on this server.'
          : draft.type === 'promql' && (!draft.dataset || !draft.labelName)
            ? 'Choose a dataset and label name.'
            : draft.type === 'promql' && draft.labelFilters?.some((filter) => !filter.label.trim())
              ? 'Enter a name for every label filter.'
              : draft.type === 'promql_query' &&
                  (!draft.promqlQueryDataset || !draft.promqlQuery?.trim())
                ? 'Choose a dataset and enter a PromQL query.'
                : draft.type === 'sql' && !draft.sqlQuery?.trim()
                  ? 'Enter a SQL query.'
                  : draft.type === 'list' && !draft.options?.length
                    ? 'Enter at least one list value.'
                    : (variableDependencyError([
                        ...variables.filter((variable) => variable.name !== original?.name),
                        draft,
                      ]) ?? '');
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={original ? 'Edit variable' : 'Add variable'}
      className="dashboard-variable-editor"
    >
      <form
        className="stack"
        onSubmit={(event) => {
          event.preventDefault();
          if (validation) return;
          onDirty(false);
          onApply(
            serializeVariable(
              { ...draft, name: draft.name.trim(), label: draft.label.trim() },
              original,
            ),
          );
        }}
      >
        <Input
          autoFocus
          label="Variable name"
          hint="Reference this as $name or ${name} in queries."
          required
          value={draft.name}
          onChange={(event) => change({ name: event.target.value })}
        />
        <Input
          label="Variable label"
          required
          value={draft.label}
          onChange={(event) => change({ label: event.target.value })}
        />
        <Select
          label="Variable type"
          value={draft.type}
          onChange={(event) => {
            setDraft((current) =>
              setVariableType(current, event.target.value as DashboardVariable['type']),
            );
            onDirty(true);
          }}
        >
          {types.map(([type, label]) => (
            <option
              key={type}
              value={type}
              disabled={!promqlEnabled && ['promql', 'promql_query'].includes(type)}
            >
              {label}
            </option>
          ))}
        </Select>
        {promqlEnabled === undefined && <p className="muted">Loading server capabilities…</p>}
        {draft.type === 'list' && (
          <div className="ui-field">
            <label className="ui-field-label" htmlFor={optionsId}>
              Values (comma separated)
            </label>
            <input
              id={optionsId}
              className="ui-input"
              value={optionsText}
              onChange={(event) => {
                setOptionsText(event.target.value);
                change({
                  options: event.target.value
                    .split(',')
                    .map((value) => value.trim())
                    .filter(Boolean),
                });
              }}
            />
          </div>
        )}
        {draft.type === 'sql' && (
          <div className="stack">
            <p className="ui-field-label">SQL query</p>
            <SqlEditor
              value={draft.sqlQuery ?? ''}
              onChange={(sqlQuery) => change({ sqlQuery })}
              onRun={() => {}}
            />
          </div>
        )}
        {draft.type === 'promql' && (
          <>
            <Select
              label="Variable dataset"
              value={draft.dataset ?? ''}
              onChange={(event) => change({ dataset: event.target.value })}
            >
              <option value="">Select a dataset</option>
              {choices.map((name) => (
                <option key={name}>{name}</option>
              ))}
            </Select>
            <Input
              label="Label name"
              value={draft.labelName ?? ''}
              onChange={(event) => change({ labelName: event.target.value })}
            />
            <Input
              label="Metric (optional)"
              value={draft.metric ?? ''}
              onChange={(event) => change({ metric: event.target.value })}
            />
            {(draft.labelFilters ?? []).map((filter, index) => (
              <div className="dashboard-filter-row" key={filterIds[index]}>
                <Input
                  label={`Filter ${index + 1} label`}
                  value={filter.label}
                  onChange={(event) =>
                    change({
                      labelFilters: draft.labelFilters!.map((filter, i) =>
                        i === index ? { ...filter, label: event.target.value } : filter,
                      ),
                    })
                  }
                />
                <Select
                  label={`Filter ${index + 1} operator`}
                  value={filter.operator}
                  onChange={(event) =>
                    change({
                      labelFilters: draft.labelFilters!.map((filter, i) =>
                        i === index
                          ? { ...filter, operator: event.target.value as typeof filter.operator }
                          : filter,
                      ),
                    })
                  }
                >
                  {['=', '!=', '=~', '!~'].map((op) => (
                    <option key={op}>{op}</option>
                  ))}
                </Select>
                <Input
                  label={`Filter ${index + 1} value`}
                  value={filter.value}
                  onChange={(event) =>
                    change({
                      labelFilters: draft.labelFilters!.map((filter, i) =>
                        i === index ? { ...filter, value: event.target.value } : filter,
                      ),
                    })
                  }
                />
                <Button
                  aria-label={`Remove filter ${index + 1}`}
                  onClick={() => {
                    setFilterIds((ids) => ids.filter((_, i) => i !== index));
                    change({ labelFilters: draft.labelFilters!.filter((_, i) => i !== index) });
                  }}
                >
                  Remove
                </Button>
              </div>
            ))}
            <Button
              onClick={() => {
                setFilterIds((ids) => [...ids, createId()]);
                change({
                  labelFilters: [
                    ...(draft.labelFilters ?? []),
                    { label: '', operator: '=', value: '' },
                  ],
                });
              }}
            >
              Add label filter
            </Button>
          </>
        )}
        {draft.type === 'promql_query' && (
          <>
            <Select
              label="Variable dataset"
              value={draft.promqlQueryDataset ?? ''}
              onChange={(event) => change({ promqlQueryDataset: event.target.value })}
            >
              <option value="">Select a dataset</option>
              {choices.map((name) => (
                <option key={name}>{name}</option>
              ))}
            </Select>
            <p className="ui-field-label">PromQL query</p>
            <PromqlEditor
              value={draft.promqlQuery ?? ''}
              onChange={(promqlQuery) => change({ promqlQuery })}
            />
            <Input
              label="Result label (optional)"
              value={draft.promqlQueryLabel ?? ''}
              onChange={(event) => change({ promqlQueryLabel: event.target.value })}
            />
          </>
        )}
        {!['dataset', 'text'].includes(draft.type) && (
          <label className="inline" htmlFor={allId}>
            <input
              id={allId}
              type="checkbox"
              checked={!!draft.includeAll}
              onChange={(event) => change({ includeAll: event.target.checked })}
            />
            Include All option
          </label>
        )}
        <Input
          label={draft.type === 'dataset' ? 'Default dataset' : 'Default value'}
          value={draft.defaultValue ?? ''}
          onChange={(event) => change({ defaultValue: event.target.value })}
        />
        <p id={reason} className="muted">
          {validation}
        </p>
        <div className="dialog-actions">
          <Button onClick={onClose}>Cancel</Button>
          <Button
            type="submit"
            variant="primary"
            data-dialog-confirm
            disabled={!!validation}
            aria-describedby={reason}
          >
            {original ? 'Apply variable' : 'Add variable'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
