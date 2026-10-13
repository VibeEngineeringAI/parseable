import { useState, type FormEvent } from 'react';
import { Button, Dialog, InlineError, Input, Select } from '../../components/ui';
import { useApp } from '../../app/AppProvider';
import { useLeaveGuard } from '../../hooks/useLeaveGuard';
import { useMutation } from '../../hooks/useMutation';
import { datasetLabelsError, datasetTags, parseStaticSchema } from '../../lib/datasetsContract';
import { forgetMetricsDatasets } from '../../lib/metrics';
import type { Dataset, DatasetTag } from '../../lib/types';
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
  const [tags, setTags] = useState<DatasetTag[]>([]);
  const [labels, setLabels] = useState('');
  const [inferTimestamp, setInferTimestamp] = useState(true);
  const [staticSchema, setStaticSchema] = useState(false);
  const [schemaText, setSchemaText] = useState(
    '{"fields":[{"name":"service","data_type":"string"}]}',
  );
  const [uploadError, setUploadError] = useState<string>();
  const mutation = useMutation();
  let schema: import('../../lib/types').DatasetStaticSchema | undefined;
  let schemaError: string | undefined;
  if (staticSchema) {
    try {
      schema = parseStaticSchema(JSON.parse(schemaText), customPartition);
    } catch (error) {
      schemaError = error instanceof Error ? error.message : String(error);
    }
  }
  const dirty =
    !!name ||
    !!customPartition ||
    !!tags.length ||
    !!labels ||
    staticSchema ||
    telemetryType !== 'logs';
  useLeaveGuard(dirty, 'dataset draft');
  function close() {
    if (!dirty || window.confirm('Discard this dataset draft?')) onClose();
  }
  const nameError = name ? validateDatasetName(name) : undefined;
  const partitionError = validateCustomPartition(customPartition);
  const labelsError =
    datasetLabelsError(
      labels
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean),
    ) ||
    (/[^\x20-\x7e]/.test(labels)
      ? 'Dataset labels must use printable ASCII characters only (space through ~).'
      : undefined);
  const valid =
    !validateDatasetName(name) && !partitionError && !schemaError && !uploadError && !labelsError;
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!valid) return;
    void mutation.run(async () => {
      try {
        await client.createDataset(name, {
          telemetryType,
          logSource: telemetryType === 'logs' ? 'json' : `otel-${telemetryType}`,
          customPartition: customPartition || undefined,
          datasetTags: tags,
          datasetLabels: labels
            .split(',')
            .map((value) => value.trim())
            .filter(Boolean),
          ...(telemetryType === 'metrics' ? { inferTimestamp } : {}),
          ...(staticSchema ? { staticSchema: schema } : {}),
        });
      } catch (error) {
        throw new Error(datasetError(error, 'create datasets'));
      }
      forgetMetricsDatasets(client);
      if (mutation.isActive()) onClose();
      onCreated();
    });
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
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
        {telemetryType === 'metrics' && (
          <label className="inline">
            <input
              type="checkbox"
              checked={inferTimestamp}
              disabled={mutation.pending}
              onChange={(event) => setInferTimestamp(event.target.checked)}
            />{' '}
            Infer metrics timestamps
            <span className="muted">
              Infers timestamp types for date/time-like string fields. Disable to preserve strings.
              Creation only.
            </span>
          </label>
        )}
        <details className="dataset-advanced">
          <summary>Advanced</summary>
          <div className="stack">
            <fieldset disabled={mutation.pending}>
              <legend>Classification tags</legend>
              {datasetTags.map((tag) => (
                <label className="inline" key={tag}>
                  <input
                    type="checkbox"
                    checked={tags.includes(tag)}
                    onChange={(event) =>
                      setTags((previous) =>
                        event.target.checked
                          ? [...previous, tag]
                          : previous.filter((value) => value !== tag),
                      )
                    }
                  />
                  {tag}
                </label>
              ))}
            </fieldset>
            <Input
              label="Labels"
              value={labels}
              onChange={(event) => setLabels(event.target.value)}
              disabled={mutation.pending}
              error={labelsError}
              hint="Printable ASCII labels separated by commas; commas cannot be part of a label. Tags and labels are set at creation."
            />
            <label className="inline">
              <input
                type="checkbox"
                checked={staticSchema}
                disabled={mutation.pending}
                onChange={(event) => setStaticSchema(event.target.checked)}
              />{' '}
              Static schema
            </label>
            {staticSchema && (
              <div className="stack">
                <label className="stack">
                  Creation schema JSON
                  <textarea
                    className="ui-input"
                    aria-label="Creation schema JSON"
                    rows={8}
                    value={schemaText}
                    disabled={mutation.pending}
                    onChange={(event) => {
                      setSchemaText(event.target.value);
                      setUploadError(undefined);
                    }}
                  />
                </label>
                <Input
                  label="Upload creation schema"
                  type="file"
                  accept=".json,application/json"
                  disabled={mutation.pending}
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (!file) return;
                    if (file.size > 100000) {
                      setUploadError('Schema upload must be at most 100 KB.');
                      return;
                    }
                    void file
                      .text()
                      .then((value) => {
                        setSchemaText(value);
                        setUploadError(undefined);
                      })
                      .catch(() => setUploadError('Could not read schema upload.'));
                  }}
                />
                <p className="muted">
                  Supported primitive types: string, int, double, float, boolean, datetime, date.
                  Use name and data_type. The server adds p_timestamp. Static schemas cannot be
                  altered later.
                </p>
                <InlineError error={schemaError || uploadError} />
              </div>
            )}
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
          <Button onClick={close} disabled={mutation.pending}>
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
