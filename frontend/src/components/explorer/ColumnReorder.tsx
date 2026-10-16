import { useRef, useState, type DragEvent, type KeyboardEvent } from 'react';
import { GripVertical } from 'lucide-react';
import { moveColumn } from './columnOrder';
import './column-reorder.css';

export function useColumnReorder(fields: string[], onChange: (fields: string[]) => void) {
  const source = useRef<string | null>(null);
  const [target, setTarget] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const move = (field: string, destination: string) => {
    const next = moveColumn(fields, field, destination);
    if (next === fields) return;
    onChange(next);
    setAnnouncement(`${field} moved to position ${next.indexOf(field) + 1} of ${next.length}.`);
  };
  const end = () => {
    source.current = null;
    setTarget(null);
  };
  return {
    announcement,
    move,
    targetProps: (field: string) => ({
      'data-column-drop-target': target === field || undefined,
      onDragOver: (event: DragEvent) => {
        if (source.current === null) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        setTarget(field);
      },
      onDragLeave: (event: DragEvent) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setTarget(null);
      },
      onDrop: (event: DragEvent) => {
        if (source.current === null) return;
        event.preventDefault();
        move(source.current, field);
        end();
      },
    }),
    handleProps: (field: string) => ({
      draggable: fields.length > 1,
      disabled: fields.length < 2,
      onDragStart: (event: DragEvent) => {
        source.current = field;
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', field);
      },
      onDragEnd: end,
      onKeyDown: (event: KeyboardEvent) => {
        const offset =
          event.key === 'ArrowLeft' || event.key === 'ArrowUp'
            ? -1
            : event.key === 'ArrowRight' || event.key === 'ArrowDown'
              ? 1
              : 0;
        if (!offset) return;
        event.preventDefault();
        const destination = fields[fields.indexOf(field) + offset];
        if (destination !== undefined) move(field, destination);
      },
    }),
  };
}

export function ColumnReorderHandle({
  field,
  reorder,
}: {
  field: string;
  reorder: ReturnType<typeof useColumnReorder>;
}) {
  return (
    <button
      type="button"
      className="column-reorder-handle"
      aria-label={`Move ${field}`}
      title={`Drag to reorder ${field}, or use arrow keys`}
      {...reorder.handleProps(field)}
    >
      <GripVertical size={12} aria-hidden="true" />
    </button>
  );
}
