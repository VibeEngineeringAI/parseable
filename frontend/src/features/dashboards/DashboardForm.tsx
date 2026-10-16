import { useCallback, useEffect, useId, useState } from 'react';
import { Button, Dialog, Input, InlineError, Select } from '../../components/ui';
import { useApp } from '../../app/AppProvider';
import { useAsync } from '../../hooks/useAsync';
import type { Dashboard } from '../../lib/types';
import { dashboardError, tagsFromText } from './helpers';

export function DashboardForm({
  original,
  pending,
  error,
  onClose,
  onSubmit,
  onDirtyChange,
  draftOnly = false,
}: {
  original?: Dashboard;
  draftOnly?: boolean;
  pending: boolean;
  error?: string;
  onClose: () => void;
  onSubmit: (
    title: string,
    tags: string[],
    description: string,
    dataset: string | null | undefined,
  ) => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const { client } = useApp();
  const datasets = useAsync(useCallback((signal) => client.listDatasets(signal), [client]));
  const [dataset, setDataset] = useState(original?.dataset ?? '');
  const datasetNames = (datasets.data ?? []).map((entry) => entry.name);
  const [title, setTitle] = useState(original?.title ?? '');
  const [tags, setTags] = useState((original?.tags ?? []).join(', '));
  const [description, setDescription] = useState(
    typeof original?.description === 'string' ? original.description : '',
  );
  const reason = useId();
  const dirty =
    dataset !== (original?.dataset ?? '') ||
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
      description={draftOnly ? 'Save the dashboard to keep these changes.' : undefined}
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
              dataset || (original?.dataset == null ? original?.dataset : null),
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
        <Select
          label="Default dataset"
          disabled={pending}
          value={dataset}
          onChange={(event) => setDataset(event.target.value)}
          hint="New tiles start with this dataset. Existing tile queries keep their datasets."
        >
          <option value="">No default dataset</option>
          {dataset && !datasetNames.includes(dataset) && <option value={dataset}>{dataset}</option>}
          {datasetNames.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </Select>
        <InlineError
          error={
            datasets.error ? 'Could not load datasets. The saved selection is retained.' : undefined
          }
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
            {pending
              ? 'Saving…'
              : draftOnly
                ? 'Apply'
                : original
                  ? 'Update dashboard'
                  : 'Create dashboard'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
