import { useEffect, useState } from 'react';
import { Button, Input, Select } from '../../components/ui';
import type { DashboardTile } from '../../lib/types';
import { record, text } from './tiles';
import {
  aggregates,
  builderAxis,
  builderSort,
  builderOrderFields,
  editableBuilder,
  newBuilderQuery,
  filterValueType,
  typedFilterValue,
  type FilterValueType,
} from './builder';

export function TileBuilderFields({
  draft,
  fields,
  change,
}: {
  draft: DashboardTile;
  fields: string[];
  change: (edits: Partial<DashboardTile>) => void;
}) {
  if (!editableBuilder(draft))
    return (
      <div className="stack">
        <p className="muted">
          This tile contains a stored query that cannot be edited visually. Its original definition
          is preserved when you apply other changes.
        </p>
        <Button onClick={() => change({ chartQuery: newBuilderQuery(draft.chartType) })}>
          Replace with a visual query
        </Button>
      </div>
    );
  const query = record(draft.chartQuery),
    x = record(query.x),
    y = record(query.y);
  const sort = record(y.sortBy ?? x.sortBy);
  const xs = Array.isArray(x.fields) ? x.fields.map(record) : [],
    ys = Array.isArray(y.fields) ? y.fields.map(record) : [];
  const filters = Array.isArray(query.filters) ? query.filters.map(record) : [];
  const options = (value: string, star = false) =>
    [...new Set([...(star ? ['*'] : []), ...fields, ...(value ? [value] : [])])].map((name) => (
      <option key={name} value={name}>
        {name === '*' ? 'All rows (*)' : name}
      </option>
    ));
  return (
    <div className="stack">
      <p className="ui-field-label">Visual query</p>
      {xs.map((field, index) => (
        <div className="inline wrap" key={index}>
          <Select
            label={`Dimension ${index + 1}`}
            value={text(field.name)}
            onChange={(event) =>
              change(
                builderAxis(draft, 'x', {
                  fields: xs.map((row, i) =>
                    i === index ? { ...row, name: event.target.value } : row,
                  ),
                }),
              )
            }
          >
            {options(text(field.name))}
          </Select>
          <Button
            onClick={() =>
              change(builderAxis(draft, 'x', { fields: xs.filter((_, i) => i !== index) }))
            }
          >
            Remove dimension {index + 1}
          </Button>
        </div>
      ))}
      <Button
        disabled={!fields.length}
        onClick={() => change(builderAxis(draft, 'x', { fields: [...xs, { name: fields[0] }] }))}
      >
        Add dimension
      </Button>
      {draft.chartType === 'timeseries' && (
        <Select
          label="Time bucket"
          value={text(x.granularity) || 'minute'}
          onChange={(event) => change(builderAxis(draft, 'x', { granularity: event.target.value }))}
        >
          {['second', 'minute', 'hour', 'day', 'week', 'month', 'quarter', 'year'].map((value) => (
            <option key={value}>{value}</option>
          ))}
        </Select>
      )}
      {ys.map((field, index) => (
        <div className="inline wrap" key={index}>
          <Select
            label={`Aggregate ${index + 1}`}
            value={text(field.aggregate).toUpperCase()}
            onChange={(event) =>
              change(
                builderAxis(draft, 'y', {
                  fields: ys.map((row, i) =>
                    i === index
                      ? {
                          ...row,
                          aggregate: event.target.value,
                          ...(event.target.value !== 'COUNT' && row.name === '*'
                            ? { name: fields[0] || '*' }
                            : {}),
                        }
                      : row,
                  ),
                }),
              )
            }
          >
            {aggregates.map((value) => (
              <option key={value}>{value}</option>
            ))}
          </Select>
          <Select
            label={`Aggregate field ${index + 1}`}
            value={text(field.name)}
            onChange={(event) =>
              change(
                builderAxis(draft, 'y', {
                  fields: ys.map((row, i) =>
                    i === index ? { ...row, name: event.target.value } : row,
                  ),
                }),
              )
            }
          >
            {options(text(field.name), text(field.aggregate).toUpperCase() === 'COUNT')}
          </Select>
          {ys.length > 1 && (
            <Button
              onClick={() =>
                change(builderAxis(draft, 'y', { fields: ys.filter((_, i) => i !== index) }))
              }
            >
              Remove aggregate {index + 1}
            </Button>
          )}
        </div>
      ))}
      {!['query-value', 'gauge'].includes(text(draft.chartType)) && (
        <Button
          onClick={() =>
            change(builderAxis(draft, 'y', { fields: [...ys, { name: '*', aggregate: 'COUNT' }] }))
          }
        >
          Add aggregate
        </Button>
      )}
      {(Array.isArray(y.groupBy) ? y.groupBy : []).map((name, index, groups) => (
        <div className="inline wrap" key={index}>
          <Select
            label={`Group by field ${index + 1}`}
            value={String(name)}
            onChange={(event) =>
              change(
                builderAxis(draft, 'y', {
                  groupBy: groups.map((value, i) => (i === index ? event.target.value : value)),
                }),
              )
            }
          >
            {options(String(name))}
          </Select>
          <Button
            onClick={() =>
              change(builderAxis(draft, 'y', { groupBy: groups.filter((_, i) => i !== index) }))
            }
          >
            Remove group {index + 1}
          </Button>
        </div>
      ))}
      <Button
        disabled={
          !fields.some((field) => !(Array.isArray(y.groupBy) ? y.groupBy : []).includes(field))
        }
        onClick={() =>
          change(
            builderAxis(draft, 'y', {
              groupBy: [
                ...(Array.isArray(y.groupBy) ? y.groupBy : []),
                fields.find(
                  (field) => !(Array.isArray(y.groupBy) ? y.groupBy : []).includes(field),
                ),
              ],
            }),
          )
        }
      >
        Add group
      </Button>
      {filters.map((filter, index) => (
        <div className="inline wrap" key={index}>
          <Select
            label={`Filter field ${index + 1}`}
            value={text(filter.column)}
            onChange={(event) =>
              change({
                chartQuery: {
                  ...query,
                  filters: filters.map((row, i) =>
                    i === index ? { ...row, column: event.target.value } : row,
                  ),
                },
              })
            }
          >
            {options(text(filter.column))}
          </Select>
          <Select
            label={`Filter operator ${index + 1}`}
            value={text(filter.operator).toLowerCase()}
            onChange={(event) =>
              change({
                chartQuery: {
                  ...query,
                  filters: filters.map((row, i) =>
                    i === index ? { ...row, operator: event.target.value } : row,
                  ),
                },
              })
            }
          >
            {['=', '!=', '<>', '<', '>', '<=', '>=', 'is null', 'is not null'].map((value) => (
              <option key={value}>{value}</option>
            ))}
          </Select>
          <FilterValueField
            index={index}
            value={filter.value}
            disabled={text(filter.operator).toLowerCase().includes('null')}
            onChange={(value) =>
              change({
                chartQuery: {
                  ...query,
                  filters: filters.map((row, i) => (i === index ? { ...row, value } : row)),
                },
              })
            }
          />
          <Button
            onClick={() =>
              change({ chartQuery: { ...query, filters: filters.filter((_, i) => i !== index) } })
            }
          >
            Remove filter {index + 1}
          </Button>
        </div>
      ))}
      <Button
        disabled={!fields.length}
        onClick={() =>
          change({
            chartQuery: {
              ...query,
              filters: [...filters, { column: fields[0], operator: '=', value: '' }],
            },
          })
        }
      >
        Add filter
      </Button>
      {!['query-value', 'gauge'].includes(text(draft.chartType)) && (
        <>
          <Select
            label="Order by"
            value={text(sort.field)}
            onChange={(event) =>
              change(
                builderSort(
                  draft,
                  event.target.value
                    ? {
                        field: event.target.value,
                        direction: text(sort.direction) || 'DESC',
                      }
                    : undefined,
                ),
              )
            }
          >
            <option value="">Default order</option>
            {[
              ...new Set([
                ...builderOrderFields(draft),
                ...(text(sort.field) ? [text(sort.field)] : []),
              ]),
            ].map((name) => (
              <option key={name}>{name}</option>
            ))}
          </Select>
          <Select
            label="Order direction"
            disabled={!text(sort.field)}
            value={text(sort.direction) || 'DESC'}
            onChange={(event) =>
              change(builderSort(draft, { ...sort, direction: event.target.value }))
            }
          >
            <option>ASC</option>
            <option>DESC</option>
          </Select>
          <RowLimitField
            value={y.limit}
            onChange={(limit) => change(builderAxis(draft, 'y', { limit }))}
          />
        </>
      )}
    </div>
  );
}

function FilterValueField({
  index,
  value,
  disabled,
  onChange,
}: {
  index: number;
  value: unknown;
  disabled: boolean;
  onChange: (value: string | number | boolean) => void;
}) {
  const type = filterValueType(value);
  const [buffer, setBuffer] = useState(String(value ?? ''));
  useEffect(() => {
    if (type !== 'boolean' && !Object.is(typedFilterValue(buffer, type), value ?? ''))
      setBuffer(String(value ?? ''));
  }, [value]);
  return (
    <>
      <Select
        label={`Filter value type ${index + 1}`}
        value={type}
        disabled={disabled}
        onChange={(event) => {
          const nextType = event.target.value as FilterValueType;
          const next =
            nextType === 'number' ? 0 : nextType === 'boolean' ? false : String(value ?? '');
          setBuffer(String(next));
          onChange(next);
        }}
      >
        <option value="text">Text</option>
        <option value="number">Number</option>
        <option value="boolean">Boolean</option>
      </Select>
      {type === 'boolean' ? (
        <Select
          label={`Filter value ${index + 1}`}
          disabled={disabled}
          value={String(value)}
          onChange={(event) => onChange(event.target.value === 'true')}
        >
          <option value="true">true</option>
          <option value="false">false</option>
        </Select>
      ) : (
        <Input
          label={`Filter value ${index + 1}`}
          disabled={disabled}
          value={buffer}
          onChange={(event) => {
            setBuffer(event.target.value);
            onChange(typedFilterValue(event.target.value, type));
          }}
        />
      )}
    </>
  );
}
function RowLimitField({
  value,
  onChange,
}: {
  value: unknown;
  onChange: (value: number | undefined) => void;
}) {
  const [buffer, setBuffer] = useState(value == null ? '' : String(value));
  useEffect(() => {
    if (!Object.is(buffer.trim() ? Number(buffer) : undefined, value ?? undefined))
      setBuffer(value == null ? '' : String(value));
  }, [value]);
  return (
    <Input
      label="Row limit"
      placeholder="No limit"
      inputMode="numeric"
      value={buffer}
      onChange={(event) => {
        setBuffer(event.target.value);
        onChange(event.target.value.trim() ? Number(event.target.value) : undefined);
      }}
    />
  );
}
