import { createId } from '../../lib/ids';
import { useState, type FormEvent } from 'react';
import { Plus, Search, X } from 'lucide-react';
import { Button, Dialog, Input, Select } from '../../components/ui';
export type LogFilter = { id: string; field: string; operator: '=' | '!='; value: string };
export function FilterBar({
  search,
  onSearch,
  filters,
  fields,
  onAdd,
  onRemove,
  onUpdate,
  onClear,
}: {
  search: string;
  onSearch: (v: string) => void;
  filters: LogFilter[];
  fields: string[];
  onAdd: (v: LogFilter) => void;
  onRemove: (id: string) => void;
  onUpdate?: (filter: LogFilter) => void;
  onClear?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<string>();
  const [field, setField] = useState('');
  const [operator, setOperator] = useState<'=' | '!='>('=');
  const [value, setValue] = useState('');
  // The field list can be empty (no schema and no returned rows), so a filter
  // is only submitted with a field that is actually on offer.
  const selected = fields.includes(field) ? field : fields[0] || '';
  function add(e: FormEvent) {
    e.preventDefault();
    if (!selected) return;
    const filter = { id: editing || createId(), field: selected, operator, value };
    if (editing && onUpdate) onUpdate(filter);
    else onAdd(filter);
    setOpen(false);
    setValue('');
  }
  return (
    <>
      <div className="filter-bar">
        <div className="search-field">
          <Search size={16} aria-hidden="true" />
          <Input
            aria-label="Search messages"
            placeholder="Search log messages…"
            value={search}
            onChange={(e) => onSearch(e.target.value)}
          />
        </div>
        <Button
          variant="secondary"
          data-testid="add-filter-button"
          onClick={() => {
            setEditing(undefined);
            setValue('');
            setOpen(true);
          }}
          disabled={!fields.length}
        >
          <Plus size={15} />
          Add filter
        </Button>
      </div>
      {filters.length > 0 && (
        <div className="filter-chips">
          {filters.map((f) => (
            <span className="filter-chip" key={f.id} data-filter-pill-id={f.id}>
              <button
                className="filter-chip-edit"
                aria-label={`Edit filter ${f.field}`}
                onClick={() => {
                  setEditing(f.id);
                  setField(f.field);
                  setOperator(f.operator);
                  setValue(f.value);
                  setOpen(true);
                }}
              >
                <strong>{f.field}</strong> {f.operator}{' '}
                <span data-testid="filter-pill-value">{f.value}</span>
              </button>
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Remove filter ${f.field} ${f.operator} ${f.value}`}
                onClick={() => onRemove(f.id)}
              >
                <X size={12} />
              </Button>
            </span>
          ))}
          {onClear && (
            <Button variant="ghost" size="sm" onClick={onClear}>
              Clear all
            </Button>
          )}
        </div>
      )}
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title={editing ? 'Edit filter' : 'Add filter'}
        description="Filter events by an exact field value."
      >
        <form onSubmit={add} className="stack">
          <Select label="Field" value={selected} onChange={(e) => setField(e.target.value)}>
            {fields.map((f) => (
              <option key={f}>{f}</option>
            ))}
          </Select>
          <Select
            label="Operator"
            value={operator}
            onChange={(e) => setOperator(e.target.value as '=' | '!=')}
          >
            <option value="=">equals</option>
            <option value="!=">does not equal</option>
          </Select>
          <Input label="Value" value={value} onChange={(e) => setValue(e.target.value)} required />
          <Button variant="primary" type="submit" data-dialog-confirm disabled={!selected}>
            Apply filter
          </Button>
        </form>
      </Dialog>
    </>
  );
}
