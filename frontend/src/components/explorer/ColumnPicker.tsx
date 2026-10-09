import { useState } from 'react';
import { Columns3 } from 'lucide-react';
import { Button, Dialog, Input } from '../ui';
export function ColumnPicker({
  fields,
  selected,
  onChange,
}: {
  fields: string[];
  selected: string[];
  onChange: (fields: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  return (
    <>
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
        <Columns3 size={14} />
        Add columns
      </Button>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="Add columns"
        description="Choose the fields to show in the results table."
      >
        <Input
          aria-label="Search columns"
          placeholder="Search columns"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="column-options">
          {fields
            .filter((f) => f.toLowerCase().includes(search.toLowerCase()))
            .map((field) => (
              <label key={field}>
                <input
                  type="checkbox"
                  checked={selected.includes(field)}
                  disabled={selected.length === 1 && selected.includes(field)}
                  onChange={() =>
                    onChange(
                      selected.includes(field)
                        ? selected.filter((f) => f !== field)
                        : [...selected, field],
                    )
                  }
                />
                {field}
              </label>
            ))}
        </div>
        <Button variant="primary" data-dialog-confirm onClick={() => setOpen(false)}>
          Done
        </Button>
      </Dialog>
    </>
  );
}
