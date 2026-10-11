import { useState, type FormEvent } from 'react';
import { Button, Dialog, InlineError, Input, Select } from '../../components/ui';
import { useApp } from '../../app/AppProvider';
import { useMutation } from '../../hooks/useMutation';
import type { Dataset } from '../../lib/types';
import { datasetError, validateCustomPartition, validateDatasetName } from './helpers';

export function CreateDatasetDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const { client } = useApp();
  const [name, setName] = useState('');
  const [telemetryType, setTelemetryType] = useState<Dataset['type']>('logs');
  const [customPartition, setCustomPartition] = useState('');
  const mutation = useMutation();
  const nameError = name ? validateDatasetName(name) : undefined;
  const partitionError = validateCustomPartition(customPartition);
  const valid = !validateDatasetName(name) && !partitionError;
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!valid) return;
    void mutation.run(async () => {
      try {
        await client.createDataset(name, {
          telemetryType,
          customPartition: customPartition || undefined,
        });
      } catch (error) {
        throw new Error(datasetError(error, 'create datasets'));
      }
      if (mutation.isActive()) onClose();
      onCreated();
    });
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      dismissible={!mutation.pending}
      title="Create dataset"
      description="Create a container for logs, metrics or traces."
    >
      <form className="stack" onSubmit={submit}>
        <Input
          label="Dataset name"
          required
          autoComplete="off"
          value={name}
          onChange={(event) => setName(event.target.value)}
          error={nameError}
          disabled={mutation.pending}
          hint="Use letters, numbers, hyphens or underscores. SQL keywords are reserved."
        />
        <Select
          label="Telemetry type"
          value={telemetryType}
          disabled={mutation.pending}
          onChange={(event) => setTelemetryType(event.target.value as Dataset['type'])}
        >
          <option value="logs">Logs</option>
          <option value="metrics">Metrics</option>
          <option value="traces">Traces</option>
        </Select>
        <details className="dataset-advanced">
          <summary>Advanced</summary>
          <div className="stack">
            <Input
              label="Custom partition"
              value={customPartition}
              autoComplete="off"
              onChange={(event) => setCustomPartition(event.target.value)}
              error={partitionError}
              disabled={mutation.pending}
              hint="One field name, without dots or commas."
            />
          </div>
        </details>
        <InlineError error={mutation.error} />
        <div className="inline">
          <Button onClick={onClose} disabled={mutation.pending}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="primary"
            data-dialog-confirm
            disabled={!valid || mutation.pending}
          >
            {mutation.pending ? 'Creating…' : 'Create dataset'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
