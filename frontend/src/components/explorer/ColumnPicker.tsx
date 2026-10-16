import { useState } from 'react';
import { ArrowDown, ArrowUp, Columns3 } from 'lucide-react';
import { Button, Dialog, Input } from '../ui';
import { ColumnReorderHandle, useColumnReorder } from './ColumnReorder';
import { orderedColumns } from './columnOrder';
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
  const [rowOrder, setRowOrder] = useState<string[]>([]);
  const groupedOrder = (selection: string[]) => [
    ...selection,
    ...fields.filter((field) => !selection.includes(field)),
  ];
  const reorder = useColumnReorder(selected, (next) => {
    setRowOrder(groupedOrder(next));
    onChange(next);
  });
  const ordered = orderedColumns([...new Set([...selected, ...fields])], rowOrder);
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => {
          setRowOrder(groupedOrder(selected));
          setOpen(true);
        }}
      >
        <Columns3 size={14} />
        Add columns
      </Button>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="Add columns"
        description="Choose fields, then drag selected fields or use the arrows to change their order."
      >
        <Input
          aria-label="Search columns"
          placeholder="Search columns"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <p className="column-order-help">
          Fields keep their place while you choose. Reopen to group selected fields in table order.
        </p>
        <div role="status" className="sr-only">
          {reorder.announcement}
        </div>
        <div className="column-options">
          {ordered
            .filter((f) => f.toLowerCase().includes(search.toLowerCase()))
            .map((field) => (
              <div
                className="column-option-row"
                style={{ minHeight: 38 }}
                key={field}
                {...(selected.includes(field) ? reorder.targetProps(field) : {})}
              >
                {selected.includes(field) ? (
                  <ColumnReorderHandle field={field} reorder={reorder} />
                ) : (
                  <span aria-hidden="true" style={{ flex: '0 0 20px' }} />
                )}
                <label>
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
                {selected.includes(field) ? (
                  <>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Move ${field} earlier`}
                      disabled={selected.indexOf(field) === 0}
                      onClick={() => reorder.move(field, selected[selected.indexOf(field) - 1])}
                    >
                      <ArrowUp size={14} />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Move ${field} later`}
                      disabled={selected.indexOf(field) === selected.length - 1}
                      onClick={() => reorder.move(field, selected[selected.indexOf(field) + 1])}
                    >
                      <ArrowDown size={14} />
                    </Button>
                  </>
                ) : (
                  <span aria-hidden="true" style={{ flex: '0 0 74px' }} />
                )}
              </div>
            ))}
        </div>
        <Button variant="primary" data-dialog-confirm onClick={() => setOpen(false)}>
          Done
        </Button>
      </Dialog>
    </>
  );
}
