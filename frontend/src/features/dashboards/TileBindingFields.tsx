import { useId, useState } from 'react';
import { Button, Input } from '../../components/ui';
import type { DashboardTile } from '../../lib/types';
import { applyBinding, bindingsFor, chartChoice, fieldList } from './chartPicker';
import { record } from './tiles';

function BindingList({
  label,
  hint,
  fields,
  list,
  max,
  onChange,
}: {
  label: string;
  hint?: string;
  fields: string[];
  list: string;
  max?: number;
  onChange: (fields: string[]) => void;
}) {
  const [value, setValue] = useState('');
  const hintId = useId();
  const full = max !== undefined && fields.length >= max;
  const canAdd = !full && !!value.trim() && !fields.includes(value.trim());
  function add() {
    if (!canAdd) return;
    onChange([...fields, value.trim()]);
    setValue('');
  }
  return (
    <div className="stack">
      <div className="dashboard-variable-control">
        <Input
          label={label}
          list={list}
          aria-describedby={hint ? hintId : undefined}
          value={value}
          disabled={full}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            add();
          }}
        />
        <Button onClick={add} disabled={!canAdd} aria-label={`Add ${label}`}>
          Add
        </Button>
      </div>
      {hint && (
        <p id={hintId} className="ui-field-message">
          {hint}
        </p>
      )}
      {!!fields.length && (
        <div className="inline wrap" role="list" aria-label={`${label} fields`}>
          {fields.map((field, index) => (
            <span role="listitem" key={`${index}-${field}`}>
              <Button
                size="sm"
                aria-label={`Remove ${field}`}
                onClick={() => onChange(fields.filter((_, i) => i !== index))}
              >
                {field} <span aria-hidden="true">×</span>
              </Button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export function TileBindingFields({
  draft,
  change,
  columns,
}: {
  draft: DashboardTile;
  change: (edits: Partial<DashboardTile>) => void;
  columns: string[];
}) {
  const list = useId();
  const bindings = bindingsFor(chartChoice(draft));
  const axes = record(record(draft.config).axes);
  if (
    draft.tileType === 'promql' ||
    (!bindings.x && !bindings.y && !bindings.groupBy && !bindings.size)
  )
    return null;
  return (
    <div className="stack">
      <h2>Data</h2>
      <datalist id={list}>
        {columns.map((column) => (
          <option key={column} value={column} />
        ))}
      </datalist>
      <div className="dashboard-editor-grid">
        {bindings.x && (
          <Input
            label={bindings.xLabel}
            list={list}
            value={fieldList(record(axes.x).field)[0] ?? ''}
            onChange={(event) => change(applyBinding(draft, 'x', event.target.value))}
          />
        )}
        {bindings.y === 'single' && (
          <Input
            label={bindings.yLabel}
            hint={bindings.yHint}
            list={list}
            value={fieldList(record(axes.y).field)[0] ?? ''}
            onChange={(event) => change(applyBinding(draft, 'y', event.target.value))}
          />
        )}
        {bindings.y === 'multi' && (
          <BindingList
            label={bindings.yLabel}
            hint={bindings.yHint}
            list={list}
            fields={fieldList(record(axes.y).field)}
            max={bindings.yMax}
            onChange={(fields) => change(applyBinding(draft, 'y', fields))}
          />
        )}
        {bindings.groupBy && (
          <BindingList
            label="Group by"
            hint={
              bindings.groupByMax === 1
                ? 'One column splits the data into series.'
                : 'Up to 2 columns split the data into series.'
            }
            list={list}
            max={bindings.groupByMax ?? 2}
            fields={fieldList(record(axes.groupBy).field)}
            onChange={(fields) => change(applyBinding(draft, 'groupBy', fields))}
          />
        )}
        {bindings.size && (
          <Input
            label="Size field"
            list={list}
            value={fieldList(record(axes.size).field)[0] ?? ''}
            onChange={(event) => change(applyBinding(draft, 'size', event.target.value))}
          />
        )}
      </div>
    </div>
  );
}
