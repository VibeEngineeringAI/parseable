import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import { Link } from 'react-router-dom';
import { ArrowUpRight } from 'lucide-react';
import { Badge, Button, InlineError, Input, Sheet, TypedConfirmDialog } from '../../components/ui';
import { QueryState } from '../../components/explorer/QueryState';
import { useApp } from '../../app/AppProvider';
import { useAsync } from '../../hooks/useAsync';
import { useLeaveGuard } from '../../hooks/useLeaveGuard';
import { useMutation } from '../../hooks/useMutation';
import { ApiError } from '../../lib/client';
import { schemaTypeLabel } from '../../lib/datasetsContract';
import { forgetMetricsDatasets } from '../../lib/metrics';
import { validateCustomPartition } from './helpers';
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
          <dd>
            {info.data.staticSchemaFlag === undefined
              ? 'Not reported'
              : info.data.staticSchemaFlag
                ? 'Static'
                : 'Inferred'}
          </dd>
          <dt>Classification tags</dt>
          <dd>
            {info.data.datasetTags === undefined
              ? 'Not reported'
              : info.data.datasetTags.join(', ') || 'None'}
          </dd>
          <dt>Labels</dt>
          <dd>
            {info.data.datasetLabels === undefined
              ? 'Not reported'
              : info.data.datasetLabels.join(', ') || 'None'}
          </dd>
          <dt>Timestamp inference</dt>
          <dd>
            {info.data.inferTimestamp === undefined
              ? 'Not reported'
              : info.data.inferTimestamp
                ? 'Enabled'
                : 'Disabled'}
          </dd>
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
    useCallback((signal) => client.datasetSchema(dataset, signal), [client, dataset]),
  );
  return (
    <Section title="Schema">
      <LoadState {...schema} action="view the dataset schema" />
      <div className="schema-list">
        {schema.data?.fields.map((field) => (
          <div key={field.name} data-field-node={field.name}>
            <code>{field.name}</code>
            <Badge>{schemaTypeLabel(field.dataType)}</Badge>
            <span className="muted">
              {field.nullable === undefined
                ? 'Nullability not reported'
                : field.nullable
                  ? 'Nullable'
                  : 'Required'}
            </span>
            {field.metadata && Object.keys(field.metadata).length > 0 && (
              <code>{JSON.stringify(field.metadata)}</code>
            )}
          </div>
        ))}
      </div>
      {schema.data?.fields.length === 0 && (
        <p className="muted">No fields yet. Ingest data to infer a schema.</p>
      )}
      {schema.data?.metadata && Object.keys(schema.data.metadata).length > 0 && (
        <p>
          Schema metadata: <code>{JSON.stringify(schema.data.metadata)}</code>
        </p>
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

function Retention({
  dataset,
  onDirty,
}: {
  dataset: string;
  onDirty: (key: string, dirty: boolean) => void;
}) {
  const { client } = useApp();
  const current = useAsync(
    useCallback((signal) => client.datasetRetention(dataset, signal), [client, dataset]),
  );
  const [days, setDays] = useState('7');
  const [edited, setEdited] = useState(false);
  const [saved, setSaved] = useState<string>();
  const mutation = useMutation();
  useEffect(() => {
    if (current.data && !edited) {
      setDays(current.data[0]?.duration.slice(0, -1) ?? '7');
      setEdited(false);
    }
  }, [current.data]);
  useEffect(() => {
    onDirty('retention', edited);
  }, [edited, onDirty]);
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
        setEdited(false);
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

function HotTier({
  dataset,
  onDirty,
}: {
  dataset: string;
  onDirty: (key: string, dirty: boolean) => void;
}) {
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
    if (current.data !== undefined && !edited) {
      setSize(current.data ? String(Number(current.data.size.replace(/ Bytes$/, '')) / gib) : '10');
      setEdited(false);
    }
  }, [current.data]);
  useEffect(() => {
    onDirty('hotTier', edited);
  }, [edited, onDirty]);
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
        setEdited(false);
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

function Partitions({
  dataset,
  onDirty,
  onChanged,
}: {
  dataset: string;
  onDirty: (key: string, dirty: boolean) => void;
  onChanged: () => void;
}) {
  const { client } = useApp();
  const info = useAsync(
    useCallback((signal) => client.datasetInfo(dataset, signal), [client, dataset]),
  );
  const schema = useAsync(
    useCallback((signal) => client.datasetSchema(dataset, signal), [client, dataset]),
  );
  const [field, setField] = useState('');
  const [days, setDays] = useState('30');
  const [fieldEdited, setFieldEdited] = useState(false);
  const [daysEdited, setDaysEdited] = useState(false);
  const [saved, setSaved] = useState<string>();
  const mutation = useMutation();
  const initializedInfo = useRef<typeof info.data>(undefined);
  useEffect(() => {
    if (info.data && initializedInfo.current !== info.data) {
      initializedInfo.current = info.data;
      if (!fieldEdited) setField(info.data.customPartition ?? '');
      if (!daysEdited) setDays(info.data.timePartitionLimit ?? '30');
    }
  }, [info.data, fieldEdited, daysEdited]);
  useEffect(() => {
    onDirty('partition', fieldEdited || daysEdited);
  }, [fieldEdited, daysEdited, onDirty]);
  let fieldError = validateCustomPartition(field);
  if (field && field === info.data?.timePartition)
    fieldError = 'The time partition field cannot be used as the custom partition.';
  if (
    field &&
    info.data?.staticSchemaFlag &&
    schema.data &&
    !schema.data.fields.some((item) => item.name === field)
  )
    fieldError = 'The custom partition must exist in the static schema.';
  const parsedDays = /^\d+$/.test(days) ? Number(days) : 0;
  const validDays = Number.isInteger(parsedDays) && parsedDays > 0 && parsedDays <= 4294967295;
  function save(kind: 'field' | 'days', remove = false) {
    setSaved(undefined);
    void mutation.run(async () => {
      try {
        if (kind === 'field')
          await client.updateDatasetCustomPartition(dataset, remove ? undefined : field);
        else await client.setDatasetTimePartitionLimit(dataset, parsedDays);
      } catch (error) {
        throw new Error(
          datasetError(
            error,
            kind === 'field' ? 'change the custom partition' : 'change the time partition limit',
          ),
        );
      }
      forgetMetricsDatasets(client);
      if (mutation.isActive()) {
        if (kind === 'field') {
          setFieldEdited(false);
          if (remove) setField('');
        } else {
          setDays(String(parsedDays));
          setDaysEdited(false);
        }
        info.reload();
        onChanged();
        setSaved(kind === 'field' ? 'Custom partition saved.' : 'Time partition limit saved.');
      }
    });
  }
  const disabled = mutation.pending || info.loading || !info.data;
  return (
    <Section title="Partitions">
      <LoadState {...info} action="view partition settings" />
      <p className="muted">
        Partition changes apply to future ingestion. Existing historical data stays queryable and is
        not repartitioned.
      </p>
      <form
        className="stack"
        onSubmit={(event) => {
          event.preventDefault();
          if (!fieldError) save('field');
        }}
      >
        <Input
          label="Custom partition field"
          value={field}
          disabled={disabled}
          error={fieldError}
          onChange={(event) => {
            setField(event.target.value);
            setFieldEdited(true);
            setSaved(undefined);
          }}
          hint="One field name. Static datasets require an existing schema field."
        />
        {info.data?.staticSchemaFlag && (
          <LoadState {...schema} action="validate static partition fields" />
        )}
        <div className="inline wrap">
          <Button
            type="submit"
            disabled={
              disabled || !!fieldError || !field || (info.data?.staticSchemaFlag && !schema.data)
            }
          >
            Save custom partition
          </Button>
          <Button
            disabled={disabled || !info.data?.customPartition}
            onClick={() => save('field', true)}
          >
            Remove custom partition
          </Button>
        </div>
      </form>
      <p className="muted">
        The time partition limit rejects incoming events older than the allowed number of days when
        a time partition field is configured. It does not delete data; retention controls deletion.
      </p>
      {info.data && !info.data.timePartition && (
        <p className="muted">
          This dataset uses ingestion time. A time partition limit has no effect without a time
          partition field.
        </p>
      )}
      <form
        className="stack"
        onSubmit={(event) => {
          event.preventDefault();
          if (validDays) save('days');
        }}
      >
        <Input
          label="Time partition limit (days)"
          type="number"
          min={1}
          max={4294967295}
          step={1}
          value={days}
          disabled={disabled || !info.data?.timePartition}
          error={
            daysEdited && !validDays ? 'Enter a whole number from 1 to 4294967295.' : undefined
          }
          onChange={(event) => {
            setDays(event.target.value);
            setDaysEdited(true);
            setSaved(undefined);
          }}
        />
        <Button type="submit" disabled={disabled || !info.data?.timePartition || !validDays}>
          Save time partition limit
        </Button>
      </form>
      <InlineError error={mutation.error} />
      {saved && <p role="status">{saved}</p>}
    </Section>
  );
}
function AlertDependencies({ dataset }: { dataset: string }) {
  const { client } = useApp();
  const alerts = useAsync(
    useCallback(
      (signal) =>
        client
          .listAlerts(signal)
          .then((items) => items.filter((item) => item.datasets.includes(dataset))),
      [client, dataset],
    ),
  );
  return (
    <div className="stack">
      <p className="muted">
        Alert dependency discovery is best effort and only includes alerts you can access. Deleting
        the dataset does not delete these rules; their evaluations may fail.
      </p>
      <LoadState {...alerts} action="list dependent alerts" />
      {alerts.error && (
        <p className="muted">
          Dependencies could not be checked. Accessible alerts may still depend on this dataset.
        </p>
      )}
      {alerts.data &&
        (alerts.data.length ? (
          <ul>
            {alerts.data.map((alert) => (
              <li key={alert.id}>
                <Link to={`/alerts/${encodeURIComponent(alert.id)}`}>{alert.title}</Link>
              </li>
            ))}
          </ul>
        ) : (
          <p>No accessible dependent alerts were returned. Other inaccessible rules may exist.</p>
        ))}
    </div>
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
  const [revision, setRevision] = useState(0);
  const [deleting, setDeleting] = useState(false);
  const [dirtySections, setDirtySections] = useState<Record<string, boolean>>({});
  const dirty = Object.values(dirtySections).some(Boolean);
  const onDirty = useCallback(
    (key: string, value: boolean) =>
      setDirtySections((previous) => ({ ...previous, [key]: value })),
    [],
  );
  useLeaveGuard(dirty, 'dataset settings');
  const mutation = useMutation();
  function remove() {
    void mutation.run(async () => {
      try {
        await client.deleteDataset(dataset);
      } catch (error) {
        throw new Error(datasetError(error, 'delete this dataset'));
      }
      forgetMetricsDatasets(client);
      if (mutation.isActive()) onClose();
      onDeleted();
    });
  }
  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open && (!dirty || window.confirm('Discard unsaved dataset settings?'))) onClose();
      }}
      dismissible={!mutation.pending}
      title={dataset}
      description="Manage dataset information, schema, retention and hot tier."
    >
      <div className="dataset-management stack">
        <Overview key={revision} dataset={dataset} />
        <Schema dataset={dataset} />
        <Partitions
          dataset={dataset}
          onDirty={onDirty}
          onChanged={() => setRevision((value) => value + 1)}
        />
        <Retention dataset={dataset} onDirty={onDirty} />
        <HotTier dataset={dataset} onDirty={onDirty} />
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
          <AlertDependencies dataset={dataset} />
        </TypedConfirmDialog>
      )}
    </Sheet>
  );
}
