import { useState, type FormEvent } from 'react';
import { Plus, Search, X } from 'lucide-react';
import { Button, Dialog, Input, Select } from '../../components/ui';
import { createId } from '../../lib/ids';
import {
  MAX_FILTER_GROUPS,
  MAX_FILTER_RULES,
  ruleCount,
  sameRule,
  addGroupRule,
  type LogFilterExpression,
  type LogFilterGroup,
} from '../../lib/logFilters';
import type { LogFilter } from '../../lib/types';
import './grouped-filter-bar.css';

type Draft = { groupId?: string; rule?: LogFilter };

export function GroupedFilterBar({
  search,
  onSearch,
  fields,
  expression,
  onChange,
  onClear,
}: {
  search: string;
  onSearch: (value: string) => void;
  fields: string[];
  expression: LogFilterExpression;
  onChange: (expression: LogFilterExpression) => void;
  onClear: () => void;
}) {
  const [draft, setDraft] = useState<Draft>();
  const [field, setField] = useState('');
  const [operator, setOperator] = useState<LogFilter['operator']>('=');
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const count = ruleCount(expression);
  const groupLimit = expression.groups.length >= MAX_FILTER_GROUPS;
  const ruleLimit = count >= MAX_FILTER_RULES;
  // Retain a saved field even when it is absent from the currently returned schema.
  const availableFields = [...new Set([...fields, ...(draft?.rule ? [draft.rule.field] : [])])];
  const selected = availableFields.includes(field) ? field : availableFields[0] || '';

  function openFilter(groupId?: string, rule?: LogFilter) {
    setDraft({ groupId, rule });
    setField(rule?.field || fields[0] || '');
    setOperator(rule?.operator || '=');
    setValue(rule?.value || '');
    setError('');
  }

  function updateGroup(id: string, update: (group: LogFilterGroup) => LogFilterGroup) {
    onChange({
      ...expression,
      groups: expression.groups.map((group) => (group.id === id ? update(group) : group)),
    });
  }

  function applyFilter(event: FormEvent) {
    event.preventDefault();
    if (!draft || !selected || !value.trim()) return;
    const group = expression.groups.find((item) => item.id === draft.groupId);
    if (draft.groupId && !group) {
      setError('This group was removed. Close this dialog and choose another group.');
      return;
    }
    if (draft.rule && !group?.rules.some((rule) => rule.id === draft.rule?.id)) {
      setError('This filter was removed. Close this dialog to add a new filter.');
      return;
    }
    if (
      !draft.rule &&
      group?.rules.some((rule) => sameRule(rule, { field: selected, operator, value }))
    ) {
      setDraft(undefined);
      return;
    }
    if (!draft.rule && ruleLimit) {
      setError(
        `You can use up to ${MAX_FILTER_RULES} filters. Remove a filter before adding another.`,
      );
      return;
    }
    if (!group && groupLimit) {
      setError(
        `You can use up to ${MAX_FILTER_GROUPS} groups. Remove a group before adding another.`,
      );
      return;
    }
    const rule: LogFilter = { id: draft.rule?.id || createId(), field: selected, operator, value };
    if (group && draft.rule) {
      updateGroup(group.id, (current) => ({
        ...current,
        rules: current.rules.map((item) => (item.id === rule.id ? rule : item)),
      }));
    } else {
      onChange(addGroupRule(expression, rule, group?.id ?? createId()));
    }
    setDraft(undefined);
  }

  return (
    <>
      <div className="filter-bar grouped-filter-toolbar">
        <div className="search-field">
          <Search size={16} aria-hidden="true" />
          <Input
            aria-label="Search messages"
            placeholder="Search log messages…"
            value={search}
            onChange={(event) => onSearch(event.target.value)}
          />
        </div>
        <Button
          variant="secondary"
          data-testid="add-filter-button"
          disabled={!fields.length || ruleLimit}
          onClick={() => openFilter(expression.groups[0]?.id)}
        >
          <Plus size={15} aria-hidden="true" /> Add filter
        </Button>
        <Button
          variant="secondary"
          data-testid="add-filter-group-button"
          disabled={groupLimit}
          onClick={() =>
            onChange({
              ...expression,
              groups: [...expression.groups, { id: createId(), combinator: 'and', rules: [] }],
            })
          }
        >
          <Plus size={15} aria-hidden="true" /> Add group
        </Button>
      </div>
      {expression.groups.length > 0 && (
        <div className="grouped-filters" aria-label="Filter groups">
          <div className="grouped-filter-heading">
            <Select
              label="Match groups"
              value={expression.combinator}
              onChange={(event) =>
                onChange({ ...expression, combinator: event.target.value as 'and' | 'or' })
              }
            >
              <option value="and">All groups (AND)</option>
              <option value="or">Any group (OR)</option>
            </Select>
            <Button variant="ghost" size="sm" onClick={onClear}>
              Clear all
            </Button>
          </div>
          {expression.groups.map((group, index) => (
            <section
              className="grouped-filter-group"
              key={group.id}
              data-filter-group-id={group.id}
              aria-label={`Filter group ${index + 1}`}
            >
              <div className="grouped-filter-heading">
                <strong>Group {index + 1}</strong>
                <Select
                  aria-label={`Match filters in group ${index + 1}`}
                  value={group.combinator}
                  onChange={(event) =>
                    updateGroup(group.id, (current) => ({
                      ...current,
                      combinator: event.target.value as 'and' | 'or',
                    }))
                  }
                >
                  <option value="and">All filters (AND)</option>
                  <option value="or">Any filter (OR)</option>
                </Select>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`Remove group ${index + 1}`}
                  onClick={() =>
                    onChange({
                      ...expression,
                      groups: expression.groups.filter((item) => item.id !== group.id),
                    })
                  }
                >
                  <X size={14} aria-hidden="true" /> Remove group
                </Button>
              </div>
              <div className="filter-chips">
                {group.rules.map((rule) => (
                  <span className="filter-chip" key={rule.id} data-filter-pill-id={rule.id}>
                    <button
                      type="button"
                      className="filter-chip-edit"
                      aria-label={`Edit filter ${rule.field}`}
                      onClick={() => openFilter(group.id, rule)}
                    >
                      <strong>{rule.field}</strong> {rule.operator}{' '}
                      <span data-testid="filter-pill-value">{rule.value}</span>
                    </button>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Remove filter ${rule.field} ${rule.operator} ${rule.value}`}
                      onClick={() =>
                        updateGroup(group.id, (current) => ({
                          ...current,
                          rules: current.rules.filter((item) => item.id !== rule.id),
                        }))
                      }
                    >
                      <X size={12} aria-hidden="true" />
                    </Button>
                  </span>
                ))}
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`Add filter to group ${index + 1}`}
                  disabled={!fields.length || ruleLimit}
                  onClick={() => openFilter(group.id)}
                >
                  <Plus size={14} aria-hidden="true" /> Add filter
                </Button>
              </div>
              {!group.rules.length && (
                <p className="grouped-filter-hint">
                  Add a filter to use this group. Empty groups are ignored.
                </p>
              )}
            </section>
          ))}
        </div>
      )}
      {(groupLimit || ruleLimit || !fields.length) && (
        <p className="grouped-filter-hint" role="status">
          {groupLimit &&
            `Group limit reached (${MAX_FILTER_GROUPS}). Remove a group to add another. `}
          {ruleLimit &&
            `Filter limit reached (${MAX_FILTER_RULES}). Remove a filter to add another. `}
          {!fields.length && 'Fields are not available yet. Load a dataset to add filters.'}
        </p>
      )}
      <Dialog
        open={!!draft}
        onOpenChange={(open) => {
          if (!open) setDraft(undefined);
        }}
        title={draft?.rule ? 'Edit filter' : 'Add filter'}
        description="Filter events by an exact field value. Use groups to combine filters with AND or OR."
      >
        <form onSubmit={applyFilter} className="stack">
          <Select label="Field" value={selected} onChange={(event) => setField(event.target.value)}>
            {availableFields.map((item) => (
              <option key={item}>{item}</option>
            ))}
          </Select>
          <Select
            label="Operator"
            value={operator}
            onChange={(event) => setOperator(event.target.value as LogFilter['operator'])}
          >
            <option value="=">equals</option>
            <option value="!=">does not equal</option>
          </Select>
          <Input
            label="Value"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            required
          />
          {error && <p role="alert">{error}</p>}
          <Button
            variant="primary"
            type="submit"
            data-dialog-confirm
            disabled={!selected || !value.trim() || (!draft?.rule && ruleLimit)}
          >
            Apply filter
          </Button>
        </form>
      </Dialog>
    </>
  );
}
