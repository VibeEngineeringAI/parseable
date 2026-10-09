import { useState } from 'react';
import { Hash } from 'lucide-react';
import { Input, Button } from '../../components/ui';
export function FieldSidebar({
  fields,
  selected,
  onToggle,
}: {
  fields: string[];
  selected: string[];
  onToggle: (field: string) => void;
}) {
  const [search, setSearch] = useState('');
  return (
    <aside className="field-sidebar" aria-label="Dataset fields">
      <Input
        aria-label="Search fields"
        placeholder="Search field names"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      <div className="panel-heading field-group-heading">
        <h2>All Fields</h2>
        <span className="count-label">{fields.length}</span>
      </div>
      {!fields.some((f) => f.toLowerCase().includes(search.toLowerCase())) && (
        <p className="muted field-empty">No fields found</p>
      )}
      {fields
        .filter((f) => f.toLowerCase().includes(search.toLowerCase()))
        .map((field) => (
          <Button
            key={field}
            variant="ghost"
            className="field-node"
            data-field-node={field}
            aria-pressed={selected.includes(field)}
            disabled={selected.length === 1 && selected.includes(field)}
            onClick={() => onToggle(field)}
          >
            <Hash size={13} />
            <span>{field}</span>
            <span className="field-check">{selected.includes(field) ? '✓' : '+'}</span>
          </Button>
        ))}
    </aside>
  );
}
