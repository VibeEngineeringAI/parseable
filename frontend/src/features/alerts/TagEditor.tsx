import { useLayoutEffect, useRef } from 'react';
import { Plus, X } from 'lucide-react';
import { Button, Input } from '../../components/ui';
import { createId } from '../../lib/ids';
import type { TagDraft } from './helpers';

export function TagEditor({
  tags,
  disabled,
  onChange,
}: {
  tags: TagDraft[];
  disabled: boolean;
  onChange: (tags: TagDraft[]) => void;
}) {
  const inputs = useRef(new Map<string, HTMLInputElement>());
  const addButton = useRef<HTMLButtonElement>(null);
  const pendingFocus = useRef<string | undefined>(undefined);
  useLayoutEffect(() => {
    if (!pendingFocus.current) return;
    (inputs.current.get(pendingFocus.current) ?? addButton.current)?.focus();
    pendingFocus.current = undefined;
  }, [tags]);
  return (
    <fieldset className="alerts-fieldset stack" disabled={disabled}>
      <legend>Tags</legend>
      <p className="muted">One tag per field. Commas and spaces are kept exactly as entered.</p>
      {tags.map((tag, index) => (
        <div className="alerts-tag-row" key={tag.id}>
          <Input
            ref={(input) => {
              if (input) inputs.current.set(tag.id, input);
              else inputs.current.delete(tag.id);
            }}
            label={`Tag ${index + 1}`}
            value={tag.value}
            onChange={(event) =>
              onChange(
                tags.map((row) =>
                  row.id === tag.id ? { ...row, value: event.target.value } : row,
                ),
              )
            }
          />
          <Button
            size="icon"
            variant="ghost"
            aria-label={`Remove tag ${index + 1}`}
            onClick={() => {
              pendingFocus.current = (tags[index + 1] ?? tags[index - 1])?.id ?? 'add';
              onChange(tags.filter((row) => row.id !== tag.id));
            }}
          >
            <X size={15} aria-hidden="true" />
          </Button>
        </div>
      ))}
      <div>
        <Button
          ref={addButton}
          size="sm"
          onClick={() => {
            const id = createId();
            pendingFocus.current = id;
            onChange([...tags, { id, value: '' }]);
          }}
        >
          <Plus size={14} aria-hidden="true" /> Add tag
        </Button>
      </div>
    </fieldset>
  );
}
