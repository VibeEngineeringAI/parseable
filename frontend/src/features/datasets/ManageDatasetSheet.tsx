import { useCallback, useEffect, useId, useState, type FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ArrowUpRight } from 'lucide-react';
import { Badge, Button, InlineError, Input, Sheet, TypedConfirmDialog } from '../../components/ui';
import { QueryState } from '../../components/explorer/QueryState';
import { useApp } from '../../app/AppProvider';
import { useAsync } from '../../hooks/useAsync';
import { useMutation } from '../../hooks/useMutation';
import { ApiError } from '../../lib/client';
import type { DatasetRetention } from '../../lib/types';
import { confirmedDatasetType, datasetPath } from '../../lib/datasetPath';
import { formatAlertDate } from '../alerts/helpers';
import {
  datasetError,
  gib,
  hotTierBytes,
  hotTierUnavailable,
  retentionDays,
  retentionFromDays,
} from './helpers';

function Section({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <section className="dataset-section stack" aria-labelledby={id}>
      <h2 id={id}>{title}</h2>
      {children}
    </section>
  );
}

function LoadState({
  loading,
  error,
  reload,
  action,
}: {
  loading: boolean;
  error?: Error;
  reload: () => void;
  action: string;
}) {
  return error instanceof ApiError && error.status === 403 ? (
    <div>
      <InlineError error={datasetError(error, action)} />
      <Button size="sm" onClick={reload}>
        Try again
      </Button>
    </div>
  ) : (
    <QueryState loading={loading} error={error} retry={reload} />
  );
}

function Overview({ dataset }: { dataset: string }) {
  const { client } = useApp();
  const info = useAsync(
    useCallback((signal) => client.datasetInfo(dataset, signal), [client, dataset]),
  );
  const stats = useAsync(
    useCallback((signal) => client.datasetStats(dataset, signal), [client, dataset]),
  );
  return (
    <Section title="Overview">
      <LoadState {...info} action="view dataset information" />
      {info.data && (
        <dl className="dataset-info">
          <dt>Telemetry type</dt>
          <dd>{info.data.telemetryType ?? 'Not reported'}</dd>
          <dt>Created</dt>
          <dd>
            {info.data.createdAt ? (
              <time dateTime={info.data.createdAt} title={info.data.createdAt}>
                {formatAlertDate(info.data.createdAt)}
              </time>
            ) : (
              'Not reported'
            )}
          </dd>
          <dt>Latest event</dt>
          <dd>
            {info.data.latestEventAt ? (
              <time dateTime={info.data.latestEventAt} title={info.data.latestEventAt}>
                {formatAlertDate(info.data.latestEventAt)}
              </time>
            ) : (
              'No events reported'
            )}
          </dd>
          <dt>Time partition</dt>
          <dd>{info.data.timePartition || 'Ingestion time'}</dd>
          <dt>Custom partition</dt>
          <dd>{info.data.customPartition || 'None'}</dd>
          <dt>Log sources</dt>
          <dd>{info.data.logSourceFormats.join(', ') || 'Not reported'}</dd>
          <dt>Schema</dt>
          <dd>{info.data.staticSchemaFlag ? 'Static' : 'Inferred'}</dd>
        </dl>
      )}
      <LoadState {...stats} action="view dataset statistics" />
      {stats.data && (
        <div className="table-scroll">
          <table className="dataset-stats">
            <caption>Ingestion and storage statistics</caption>
            <thead>
              <tr>
                <th scope="col">Measure</th>
                <th scope="col">Current</th>
                <th scope="col">Lifetime</th>
                <th scope="col">Deleted</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <th scope="row">Events</th>
                <td>{stats.data.ingestion.count.toLocaleString()}</td>
                <td>{stats.data.ingestion.lifetime_count.toLocaleString()}</td>
                <td>{stats.data.ingestion.deleted_count.toLocaleString()}</td>
              </tr>
              <tr>
                <th scope="row">Ingested ({stats.data.ingestion.format})</th>
                <td>{stats.data.ingestion.size.toLocaleString()} bytes</td>
                <td>{stats.data.ingestion.lifetime_size.toLocaleString()} bytes</td>
                <td>{stats.data.ingestion.deleted_size.toLocaleString()} bytes</td>
              </tr>
              <tr>
                <th scope="row">Stored ({stats.data.storage.format})</th>
                <td>{stats.data.storage.size.toLocaleString()} bytes</td>
                <td>{stats.data.storage.lifetime_size.toLocaleString()} bytes</td>
                <td>{stats.data.storage.deleted_size.toLocaleString()} bytes</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}

function Schema({ dataset }: { dataset: string }) {
  const { client } = useApp();
  const info = useAsync(
    useCallback((signal) => client.datasetInfo(dataset, signal), [client, dataset]),
  );
  const explorerType = info.data ? confirmedDatasetType(info.data) : undefined;
  const schema = useAsync(
    useCallback((signal) => client.schema(dataset, signal), [client, dataset]),
  );
  return (
    <Section title="Schema">
      <LoadState {...schema} action="view the dataset schema" />
      <div className="schema-list">
        {schema.data?.map((field) => (
          <div key={field} data-field-node={field}>
            <code>{field}</code>
            <Badge>field</Badge>
          </div>
        ))}
      </div>
      {schema.data?.length === 0 && (
        <p className="muted">No fields yet. Ingest data to infer a schema.</p>
      )}
      <LoadState {...info} action="determine the dataset explorer" />
      {info.data && !explorerType && (
        <p className="muted">
          Explore unavailable: dataset metadata does not identify a supported telemetry source.
        </p>
      )}
      {explorerType && (
        <Link className="text-link" to={datasetPath({ name: dataset, type: explorerType })}>
          Explore dataset <ArrowUpRight size={14} aria-hidden="true" />
        </Link>
      )}
    </Section>
  );
}

function Retention({ dataset }: { dataset: string }) {
  const { client } = useApp();
  const current = useAsync(
    useCallback((signal) => client.datasetRetention(dataset, signal), [client, dataset]),
  );
  const [days, setDays] = useState('7');
  const [edited, setEdited] = useState(false);
  const [saved, setSaved] = useState<string>();
  const mutation = useMutation();
  useEffect(() => {
    if (current.data) {
      setDays(current.data[0]?.duration.slice(0, -1) ?? '7');
      setEdited(false);
    }
  }, [current.data]);
  const parsed = retentionDays(days);
  function update(retention: DatasetRetention) {
    setSaved(undefined);
    void mutation.run(async () => {
      try {
        await client.setDatasetRetention(dataset, retention);
      } catch (error) {
        throw new Error(datasetError(error, 'change dataset retention'));
      }
      if (mutation.isActive()) {
        current.reload();
        setSaved(retention.length ? 'Retention saved.' : 'Retention cleared.');
      }
    });
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    if (parsed !== undefined) update(retentionFromDays(parsed));
  }
  return (
    <Section title="Retention">
      <LoadState {...current} action="view dataset retention" />
      {current.data && (
        <p className="muted">
          {current.data.length
            ? `Current policy: delete data older than ${current.data[0].duration.slice(0, -1)} days.`
            : 'No retention policy. Data is kept indefinitely.'}
        </p>
      )}
      <form className="stack" onSubmit={submit}>
        <Input
          label="Delete data older than N days"
          type="number"
          min={1}
          max={36500}
          step={1}
          required
          value={days}
          onChange={(event) => {
            setDays(event.target.value);
            setEdited(true);
            setSaved(undefined);
          }}
          error={
            edited && parsed === undefined
              ? 'Enter a whole number from 1 to 36500 days.'
              : undefined
          }
          hint="1–36,500 days. Saving replaces the current retention policy."
          disabled={mutation.pending || current.loading}
        />
        <InlineError error={mutation.error} />
        {saved && (
          <p role="status" className="muted">
            {saved}
          </p>
        )}
        <div className="inline wrap">
          <Button
            type="submit"
            variant="primary"
            disabled={parsed === undefined || mutation.pending || current.loading}
          >
            Save retention
          </Button>
          <Button
            onClick={() => update([])}
            disabled={mutation.pending || current.loading || !current.data?.length}
          >
            Clear retention
          </Button>
        </div>
      </form>
    </Section>
  );
}

function HotTier({ dataset }: { dataset: string }) {
  const { client } = useApp();
  const current = useAsync(
    useCallback((signal) => client.datasetHotTier(dataset, signal), [client, dataset]),
  );
  const [size, setSize] = useState('10');
  const [edited, setEdited] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [saved, setSaved] = useState<string>();
  const mutation = useMutation();
  useEffect(() => {
    if (current.data !== undefined) {
      setSize(current.data ? String(Number(current.data.size.replace(/ Bytes$/, '')) / gib) : '10');
      setEdited(false);
    }
  }, [current.data]);
  const bytes = hotTierBytes(size);
  const disabled = unavailable || hotTierUnavailable(current.error);
  function update(clear = false) {
    if (!clear && !bytes) return;
    setSaved(undefined);
    void mutation.run(async () => {
      try {
        if (clear) await client.clearDatasetHotTier(dataset);
        else await client.setDatasetHotTier(dataset, bytes!);
      } catch (error) {
        if (hotTierUnavailable(error)) {
          if (mutation.isActive()) setUnavailable(true);
          return;
        }
        throw new Error(datasetError(error, 'change the dataset hot tier'));
      }
      if (mutation.isActive()) {
        current.reload();
        setSaved(clear ? 'Hot tier disabled.' : 'Hot tier saved.');
      }
    });
  }
  return (
    <Section title="Hot tier">
      {disabled ? (
        <p className="muted">
          Hot tier is unavailable because it is not enabled in the server configuration.
        </p>
      ) : (
        <>
          <LoadState {...current} action="view the dataset hot tier" />
          {current.data === null && (
            <p className="muted">Hot tier is not enabled for this dataset.</p>
          )}
          {current.data && (
            <dl className="dataset-info">
              <dt>Allocated</dt>
              <dd>{current.data.size}</dd>
              <dt>Used</dt>
              <dd>{current.data.used_size}</dd>
              <dt>Available</dt>
              <dd>{current.data.available_size}</dd>
            </dl>
          )}
          <form
            className="stack"
            onSubmit={(event) => {
              event.preventDefault();
              update();
            }}
          >
            <Input
              label="Hot tier size (GiB)"
              type="number"
              min={10}
              step="any"
              required
              value={size}
              onChange={(event) => {
                setSize(event.target.value);
                setEdited(true);
                setSaved(undefined);
              }}
              disabled={mutation.pending || current.loading}
              hint="At least 10 GiB. The server checks available capacity."
              error={
                edited && !bytes
                  ? 'Enter at least 10 GiB, representable in whole bytes.'
                  : undefined
              }
            />
            <InlineError error={mutation.error} />
            {saved && (
              <p role="status" className="muted">
                {saved}
              </p>
            )}
            <div className="inline wrap">
              <Button
                type="submit"
                variant="primary"
                disabled={!bytes || mutation.pending || current.loading}
              >
                Save hot tier
              </Button>
              <Button
                onClick={() => update(true)}
                disabled={!current.data || mutation.pending || current.loading}
              >
                Disable hot tier
              </Button>
            </div>
          </form>
        </>
      )}
    </Section>
  );
}

export function ManageDatasetSheet({
  dataset,
  onClose,
  onDeleted,
}: {
  dataset: string;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const { client } = useApp();
  const [deleting, setDeleting] = useState(false);
  const mutation = useMutation();
  function remove() {
    void mutation.run(async () => {
      try {
        await client.deleteDataset(dataset);
      } catch (error) {
        throw new Error(datasetError(error, 'delete this dataset'));
      }
      if (mutation.isActive()) onClose();
      onDeleted();
    });
  }
  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      dismissible={!mutation.pending}
      title={dataset}
      description="Manage dataset information, schema, retention and hot tier."
    >
      <div className="dataset-management stack">
        <Overview dataset={dataset} />
        <Schema dataset={dataset} />
        <Retention dataset={dataset} />
        <HotTier dataset={dataset} />
        <Section title="Danger zone">
          <p className="muted">
            Deleting this dataset permanently removes its data and configuration.
          </p>
          <Button
            variant="danger"
            onClick={() => {
              mutation.reset();
              setDeleting(true);
            }}
          >
            Delete dataset
          </Button>
        </Section>
      </div>
      {deleting && (
        <TypedConfirmDialog
          open
          onOpenChange={(open) => {
            if (!open) setDeleting(false);
          }}
          title="Delete dataset"
          name={dataset}
          action="Delete dataset"
          onConfirm={remove}
          pending={mutation.pending}
          error={mutation.error}
        >
          <p className="muted">All data in {dataset} will be permanently deleted.</p>
        </TypedConfirmDialog>
      )}
    </Sheet>
  );
}
