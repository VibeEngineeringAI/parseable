import { useState, type FormEvent } from 'react';
import { Plus, RefreshCw } from 'lucide-react';
import { Button, InlineError, Input, Select, Spinner } from '../../components/ui';
import type { Dataset, DatasetInfo } from '../../lib/types';
import { validateDatasetName } from '../datasets/helpers';
import { validateIngestionDataset } from '../../lib/ingestion';

export function DatasetStep({
  datasets,
  dataset,
  onSelect,
  onCreate,
  loading,
  error,
  reload,
  pending,
  createError,
  resetCreateError,
  info,
  infoLoading,
  infoError,
  retryInfo,
  compatibilityError,
}: {
  datasets: Dataset[];
  dataset: string;
  onSelect: (value: string) => void;
  onCreate: (name: string) => Promise<boolean>;
  loading: boolean;
  error?: string;
  reload: () => void;
  pending: boolean;
  createError?: string;
  resetCreateError: () => void;
  info?: DatasetInfo;
  infoLoading: boolean;
  infoError?: string;
  retryInfo: () => void;
  compatibilityError?: string;
}) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const validationError = validateDatasetName(name) || validateIngestionDataset(name);
  const nameError = name ? validationError : undefined;
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (validationError) return;
    if (await onCreate(name)) {
      setCreating(false);
      setName('');
    }
  }
  return (
    <div className="stack">
      <div className="ingestion-dataset-row">
        <Select
          label="Destination dataset"
          value={dataset}
          disabled={loading || pending}
          onChange={(event) => onSelect(event.target.value)}
        >
          <option value="">{loading ? 'Loading datasets…' : 'Select a dataset'}</option>
          {dataset && !datasets.some((item) => item.name === dataset) && (
            <option value={dataset}>{dataset}</option>
          )}
          {datasets.map((item) => (
            <option key={item.name} value={item.name}>
              {item.name}
            </option>
          ))}
        </Select>
        <Button
          onClick={() => {
            resetCreateError();
            setCreating(!creating);
          }}
          disabled={pending}
          aria-expanded={creating}
        >
          <Plus size={15} aria-hidden="true" />
          Create new dataset
        </Button>
        <Button
          size="icon"
          onClick={reload}
          disabled={loading || pending}
          aria-label="Refresh datasets"
        >
          <RefreshCw size={15} aria-hidden="true" />
        </Button>
      </div>
      <InlineError error={error} />
      {creating && (
        <form className="ingestion-create-form" onSubmit={(event) => void submit(event)}>
          <Input
            label="New dataset name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            error={nameError}
            required
            autoComplete="off"
            disabled={pending}
            hint="The dataset will use the selected signal and source format."
          />
          <div className="inline">
            <Button type="submit" variant="primary" disabled={Boolean(validationError) || pending}>
              {pending ? 'Creating…' : 'Create dataset'}
            </Button>
            <Button
              onClick={() => {
                resetCreateError();
                setCreating(false);
              }}
              disabled={pending}
            >
              Cancel
            </Button>
          </div>
          <InlineError error={createError} />
        </form>
      )}
      {dataset && (
        <div className="ingestion-dataset-detail">
          {infoLoading ? (
            <span role="status">
              <Spinner size={14} /> Checking dataset format…
            </span>
          ) : (
            info && (
              <span>
                {info.telemetryType || 'Telemetry type unavailable'} ·{' '}
                {info.logSourceFormats.join(', ') || 'Source format unavailable'}
              </span>
            )
          )}
          <InlineError error={infoError || compatibilityError} />
          {infoError && (
            <Button size="sm" onClick={retryInfo}>
              Retry dataset check
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
