import { Plus, X } from 'lucide-react';
import { Button, Input } from '../../components/ui';

export function TagEditor({
  tags,
  disabled,
  onChange,
}: {
  tags: string[];
  disabled: boolean;
  onChange: (tags: string[]) => void;
}) {
  return (
    <fieldset className="alerts-fieldset stack" disabled={disabled}>
      <legend>Tags</legend>
      <p className="muted">One tag per field. Commas and spaces are kept exactly as entered.</p>
      {tags.map((tag, index) => (
        <div className="alerts-tag-row" key={index}>
          <Input
            label={`Tag ${index + 1}`}
            value={tag}
            onChange={(event) =>
              onChange(
                tags.map((value, position) => (position === index ? event.target.value : value)),
              )
            }
          />
          <Button
            size="icon"
            variant="ghost"
            aria-label={`Remove tag ${index + 1}`}
            onClick={() => onChange(tags.filter((_, position) => position !== index))}
          >
            <X size={15} aria-hidden="true" />
          </Button>
        </div>
      ))}
      <div>
        <Button size="sm" onClick={() => onChange([...tags, ''])}>
          <Plus size={14} aria-hidden="true" /> Add tag
        </Button>
      </div>
    </fieldset>
  );
}
