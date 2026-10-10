import { useEffect, useId, useState } from 'react';
import { Button, Dialog, Input } from '../../components/ui';
import type { Dashboard } from '../../lib/types';
import { InlineError } from '../../components/ui';
import { dashboardError, tagsFromText } from './helpers';

export function DashboardForm({
  original,
  pending,
  error,
  onClose,
  onSubmit,
  onDirtyChange,
}: {
  original?: Dashboard;
  pending: boolean;
  error?: string;
  onClose: () => void;
  onSubmit: (title: string, tags: string[], description: string) => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const [title, setTitle] = useState(original?.title ?? '');
  const [tags, setTags] = useState((original?.tags ?? []).join(', '));
  const [description, setDescription] = useState(
    typeof original?.description === 'string' ? original.description : '',
  );
  const reason = useId();
  const dirty =
    title !== (original?.title ?? '') ||
    tags !== (original?.tags ?? []).join(', ') ||
    description !== (typeof original?.description === 'string' ? original.description : '');
  useEffect(() => {
    onDirtyChange(dirty);
    return () => onDirtyChange(false);
  }, [dirty, onDirtyChange]);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      dismissible={!pending}
      title={original ? 'Rename and tags' : 'Create dashboard'}
    >
      <form
        className="stack"
        onSubmit={(event) => {
          event.preventDefault();
          if (title.trim())
            onSubmit(
              title === original?.title ? title : title.trim(),
              tags === (original?.tags ?? []).join(', ')
                ? (original?.tags ?? [])
                : tagsFromText(tags),
              description === original?.description ? description : description.trim(),
            );
        }}
      >
        <Input
          label="Dashboard title"
          disabled={pending}
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          required
          autoFocus
        />
        <Input
          label="Tags"
          disabled={pending}
          hint="Separate tags with commas."
          value={tags}
          onChange={(event) => setTags(event.target.value)}
        />
        <Input
          label="Description"
          disabled={pending}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
        <p id={reason} className="muted">
          {!title.trim() ? 'Enter a dashboard title.' : ''}
        </p>
        <InlineError error={dashboardError(error)} />
        <div className="dialog-actions">
          <Button onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="primary"
            data-dialog-confirm
            disabled={pending || !title.trim()}
            aria-describedby={reason}
          >
            {pending ? 'Saving…' : original ? 'Update dashboard' : 'Create dashboard'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
