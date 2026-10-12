import { useState } from 'react';
import { Button, Dialog, Input } from '../../components/ui';

export function SectionDialog({
  title,
  onClose,
  onApply,
  onDirty,
}: {
  title?: string;
  onClose: () => void;
  onApply: (title: string) => void;
  onDirty: (dirty: boolean) => void;
}) {
  const [value, setValue] = useState(title ?? '');
  return (
    <Dialog
      open
      title={title === undefined ? 'Add section' : 'Rename section'}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <form
        className="stack"
        onSubmit={(event) => {
          event.preventDefault();
          if (value.trim()) onApply(value.trim());
        }}
      >
        <Input
          autoFocus
          label="Section title"
          required
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
            onDirty(true);
          }}
        />
        <div className="dialog-actions">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={!value.trim()}>
            {title === undefined ? 'Add section' : 'Rename section'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
