import { useCallback } from 'react';
import { Button, Input, Select, InlineError } from '../../components/ui';
import { QueryState } from '../../components/explorer/QueryState';
import { useApp } from '../../app/AppProvider';
import { useAsync } from '../../hooks/useAsync';
import { sqlFieldType, sqlFilterOperators, type SqlBuilderV1 } from '../../lib/sqlBuilderContract';
import type { DatasetSchemaField, LogContextConditions } from '../../lib/types';

type Condition = NonNullable<LogContextConditions['conditionConfig']>[number];
const totals = (group: LogContextConditions): { rules: number; groups: number } =>
  (group.groups ?? []).reduce(
    (sum, child) => {
      const count = totals(child);
      return { rules: sum.rules + count.rules, groups: sum.groups + count.groups + 1 };
    },
    { rules: group.conditionConfig?.length ?? 0, groups: 0 },
  );
function ConditionGroup({
  value,
  onChange,
  fields,
  disabled,
  depth = 0,
  path = 'Filters',
  canAddRule,
  canAddGroup,
}: {
  value: LogContextConditions;
  onChange: (value: LogContextConditions) => void;
  fields: DatasetSchemaField[];
  disabled: boolean;
  depth?: number;
  path?: string;
  canAddRule: boolean;
  canAddGroup: boolean;
}) {
  const rules = value.conditionConfig ?? [],
    groups = value.groups ?? [];
  const update = (index: number, rule: Condition) =>
    onChange({ ...value, conditionConfig: rules.map((item, i) => (i === index ? rule : item)) });
  const first = fields.find((field) => sqlFieldType(field));
  return (
    <fieldset className="alerts-fieldset stack" disabled={disabled}>
      <legend>{path}</legend>
      <Select
        label={`${path} match`}
        value={value.operator ?? 'and'}
        onChange={(event) => onChange({ ...value, operator: event.target.value as 'and' | 'or' })}
      >
        <option value="and">All conditions (AND)</option>
        <option value="or">Any condition (OR)</option>
      </Select>
      {rules.map((rule, index) => {
        const type = sqlFieldType(
            fields.find((field) => field.name === rule.column) ?? { name: rule.column },
          ),
          ops = sqlFilterOperators(type);
        return (
          <div key={index} className="stack">
            <div className="alerts-fields">
              <Select
                label={`${path} field ${index + 1}`}
                value={rule.column}
                onChange={(event) => {
                  const field = fields.find((item) => item.name === event.target.value);
                  update(index, {
                    column: event.target.value,
                    operator: '=',
                    type: field ? sqlFieldType(field) : undefined,
                    value: '',
                  });
                }}
              >
                <option value="">Select field</option>
                {fields
                  .filter((field) => sqlFieldType(field))
                  .map((field) => (
                    <option key={field.name} value={field.name}>
                      {field.name} ({sqlFieldType(field)})
                    </option>
                  ))}
              </Select>
              <Select
                label={`${path} operator ${index + 1}`}
                value={rule.operator}
                onChange={(event) =>
                  update(index, {
                    ...rule,
                    operator: event.target.value as Condition['operator'],
                    value: ['is null', 'is not null'].includes(event.target.value)
                      ? ''
                      : rule.value,
                  })
                }
              >
                {ops.map((op) => (
                  <option key={op}>{op}</option>
                ))}
              </Select>
              {!['is null', 'is not null'].includes(rule.operator) &&
                (type === 'boolean' ? (
                  <Select
                    label={`${path} value ${index + 1}`}
                    value={rule.value ?? ''}
                    onChange={(event) => update(index, { ...rule, value: event.target.value })}
                  >
                    <option value="">Select boolean</option>
                    <option value="true">True</option>
                    <option value="false">False</option>
                  </Select>
                ) : (
                  <Input
                    label={`${path} value ${index + 1}`}
                    value={rule.value ?? ''}
                    maxLength={1024}
                    onChange={(event) => update(index, { ...rule, value: event.target.value })}
                    hint={
                      type === 'int'
                        ? 'Exact integer; large values remain text.'
                        : type === 'timestamp'
                          ? 'RFC 3339 timestamp, for example 2026-10-12T12:00:00Z.'
                          : type === 'float'
                            ? 'Finite number.'
                            : undefined
                    }
                  />
                ))}
            </div>
            <div>
              <Button
                size="sm"
                onClick={() =>
                  onChange({ ...value, conditionConfig: rules.filter((_, i) => i !== index) })
                }
              >
                Remove {path.toLowerCase()} condition {index + 1}
              </Button>
            </div>
          </div>
        );
      })}
      {groups.map((group, index) => (
        <div className="stack" key={index}>
          <ConditionGroup
            value={group}
            fields={fields}
            disabled={disabled}
            depth={depth + 1}
            path={`${path} group ${index + 1}`}
            canAddRule={canAddRule}
            canAddGroup={canAddGroup}
            onChange={(next) =>
              onChange({ ...value, groups: groups.map((item, i) => (i === index ? next : item)) })
            }
          />
          <Button
            size="sm"
            onClick={() => onChange({ ...value, groups: groups.filter((_, i) => i !== index) })}
          >
            Remove {path.toLowerCase()} group {index + 1}
          </Button>
        </div>
      ))}
      <div className="inline wrap">
        <Button
          size="sm"
          disabled={!first || !canAddRule}
          onClick={() =>
            onChange({
              ...value,
              conditionConfig: [
                ...rules,
                {
                  column: first!.name,
                  operator: '=',
                  type: sqlFieldType(first!),
                  value: sqlFieldType(first!) === 'boolean' ? 'true' : '',
                },
              ],
            })
          }
        >
          Add {path.toLowerCase()} condition
        </Button>
        <Button
          size="sm"
          disabled={!first || !canAddGroup || !canAddRule || depth >= 3}
          onClick={() =>
            onChange({
              ...value,
              groups: [
                ...groups,
                {
                  operator: 'and',
                  conditionConfig: [
                    {
                      column: first!.name,
                      operator: '=',
                      type: sqlFieldType(first!),
                      value: sqlFieldType(first!) === 'boolean' ? 'true' : '',
                    },
                  ],
                },
              ],
            })
          }
        >
          Add {path.toLowerCase()} group
        </Button>
      </div>
    </fieldset>
  );
}
export function SqlAlertBuilder({
  value,
  onChange,
  disabled,
  error,
}: {
  value: SqlBuilderV1;
  onChange: (value: SqlBuilderV1) => void;
  disabled: boolean;
  error?: string;
}) {
  const { client } = useApp();
  const schema = useAsync(
    useCallback(
      (signal) =>
        value.dataset
          ? client.datasetSchema(value.dataset, signal)
          : Promise.resolve({ fields: [] }),
      [client, value.dataset],
    ),
  );
  const fields = schema.data?.fields ?? [],
    numeric = fields.filter((field) => ['int', 'float'].includes(sqlFieldType(field) ?? ''));
  const groupFields = fields.filter(
    (field) =>
      !['p_timestamp', 'alert_value'].includes(field.name) &&
      ['int', 'string', 'boolean'].includes(sqlFieldType(field) ?? ''),
  );
  const filters = value.filters ?? { operator: 'and', conditionConfig: [] },
    count = totals(filters);
  const missing =
    value.aggregate.column && !fields.some((field) => field.name === value.aggregate.column);
  return (
    <div className="stack">
      <QueryState loading={schema.loading} error={schema.error} retry={schema.reload} />
      <div className="alerts-fields">
        <Select
          label="Aggregate function"
          value={value.aggregate.function}
          disabled={disabled}
          onChange={(event) =>
            onChange({
              ...value,
              aggregate: {
                function: event.target.value as SqlBuilderV1['aggregate']['function'],
                ...(event.target.value === 'count'
                  ? {}
                  : { column: value.aggregate.column ?? numeric[0]?.name }),
              },
            })
          }
        >
          {['count', 'sum', 'avg', 'min', 'max'].map((fn) => (
            <option key={fn} value={fn}>
              {fn.toUpperCase()}
            </option>
          ))}
        </Select>
        <Select
          label="Aggregate field"
          value={value.aggregate.column ?? ''}
          disabled={disabled || schema.loading}
          onChange={(event) =>
            onChange({
              ...value,
              aggregate: { ...value.aggregate, column: event.target.value || undefined },
            })
          }
        >
          <option value="">
            {value.aggregate.function === 'count' ? 'All rows (*)' : 'Select numeric field'}
          </option>
          {missing && (
            <option value={value.aggregate.column}>{value.aggregate.column} (unavailable)</option>
          )}
          {(value.aggregate.function === 'count' ? fields : numeric).map((field) => (
            <option key={field.name} value={field.name}>
              {field.name}
            </option>
          ))}
        </Select>
      </div>
      <ConditionGroup
        value={filters}
        onChange={(filters) => onChange({ ...value, filters })}
        fields={fields}
        disabled={disabled || schema.loading || !!schema.error}
        canAddRule={count.rules < 20}
        canAddGroup={count.groups < 10}
      />
      <fieldset className="alerts-fieldset" disabled={disabled || schema.loading}>
        <legend>Group by (up to 3 fields)</legend>
        {groupFields.map((field) => (
          <label className="alerts-checkbox" key={field.name}>
            <input
              type="checkbox"
              checked={value.groupBy?.includes(field.name) ?? false}
              disabled={!value.groupBy?.includes(field.name) && (value.groupBy?.length ?? 0) >= 3}
              onChange={(event) =>
                onChange({
                  ...value,
                  groupBy: event.target.checked
                    ? [...(value.groupBy ?? []), field.name]
                    : (value.groupBy ?? []).filter((name) => name !== field.name),
                })
              }
            />
            {field.name}
          </label>
        ))}
      </fieldset>
      <p className="muted">
        One numeric aggregate per rule. Filters are typed from the dataset schema. Maximum 20
        conditions, 10 groups and 3 nesting levels. The server validates and compiles this
        specification on preview and save.
      </p>
      <InlineError
        error={
          error || (missing ? 'The aggregate field is no longer present in the schema.' : undefined)
        }
      />
    </div>
  );
}
