import { useCallback, useState } from 'react';
import { Button, Input } from '../../components/ui';
import { QueryState } from '../../components/explorer/QueryState';
import { useAsync } from '../../hooks/useAsync';
import { metadataRequest, type Bounds } from './helpers';
import type { ParseableClient } from '../../lib/types';

function MetadataList({
  title,
  items,
  selected,
  onSelect,
}: {
  title: string;
  items: string[];
  selected?: string;
  onSelect: (value: string) => void;
}) {
  const [search, setSearch] = useState('');
  const [limit, setLimit] = useState(300);
  const filtered = items.filter((item) => item.toLowerCase().includes(search.toLowerCase()));
  return (
    <section className="metrics-metadata-list" aria-label={title}>
      <div className="metrics-browser-heading">
        <h3>{title}</h3>
        <span className="muted">
          {filtered.length} of {items.length}
        </span>
      </div>
      <Input
        aria-label={`Search ${title.toLowerCase()}`}
        placeholder={`Search ${title.toLowerCase()}`}
        value={search}
        onChange={(event) => {
          setSearch(event.target.value);
          setLimit(300);
        }}
      />
      <ul>
        {filtered.slice(0, limit).map((item) => (
          <li key={item}>
            <Button
              size="sm"
              variant="ghost"
              aria-pressed={selected === undefined ? undefined : selected === item}
              onClick={() => onSelect(item)}
            >
              {item || '(empty)'}
            </Button>
          </li>
        ))}
      </ul>
      {!filtered.length && <p className="muted">No matching {title.toLowerCase()}</p>}
      {filtered.length > limit && (
        <Button size="sm" onClick={() => setLimit((count) => count + 300)}>
          Show more ({filtered.length - limit})
        </Button>
      )}
    </section>
  );
}

function TruncationWarning({ truncated }: { truncated?: boolean }) {
  return truncated ? (
    <p className="metrics-metadata-warning" role="status">
      Metadata results truncated to the requested limit.
    </p>
  ) : null;
}

export function LabelBrowser({
  client,
  dataset,
  bounds,
  activeEmpty,
  full,
  onInsert,
}: {
  client: ParseableClient;
  dataset: string;
  bounds: Bounds;
  activeEmpty: boolean;
  full: boolean;
  onInsert: (metric: string, labelValue?: { label: string; value: string }) => void;
}) {
  const [metric, setMetric] = useState('');
  const [label, setLabel] = useState('');
  const metrics = useAsync(
    useCallback(
      (signal) => {
        const request = metadataRequest(dataset, bounds);
        return request
          ? client.promqlLabelValues('__name__', request, signal)
          : Promise.resolve({ data: [], truncated: false });
      },
      [client, dataset, bounds],
    ),
  );
  const labels = useAsync(
    useCallback(
      (signal) => {
        const request = metric ? metadataRequest(dataset, bounds, [metric]) : undefined;
        return request
          ? client.promqlLabels(request, signal)
          : Promise.resolve({ data: [], truncated: false });
      },
      [client, dataset, bounds, metric],
    ),
  );
  const values = useAsync(
    useCallback(
      (signal) => {
        const request = metric && label ? metadataRequest(dataset, bounds, [metric]) : undefined;
        return request
          ? client.promqlLabelValues(label, request, signal)
          : Promise.resolve({ data: [], truncated: false });
      },
      [client, dataset, bounds, metric, label],
    ),
  );
  return (
    <aside id="metrics-label-browser" className="metrics-label-browser" aria-label="Label browser">
      <h2>Label browser</h2>
      <p className="muted metrics-browser-help">
        Choose a metric to see its labels. Values are added to the active query when it is empty or
        selects only that metric; otherwise they start a new query.
      </p>
      <QueryState loading={metrics.loading} error={metrics.error} retry={metrics.reload} />
      {metrics.data && (
        <MetadataList
          title="Metrics"
          items={metrics.data.data}
          selected={metric}
          onSelect={(name) => {
            setMetric(name);
            setLabel('');
          }}
        />
      )}
      <TruncationWarning truncated={metrics.data?.truncated} />
      {metric && (
        <>
          <div className="metrics-browser-selection">
            <strong className="mono">{metric}</strong>
            <Button size="sm" disabled={!activeEmpty && full} onClick={() => onInsert(metric)}>
              {activeEmpty ? 'Use metric' : 'Add as new query'}
            </Button>
          </div>
          {!activeEmpty && full && <p className="muted">Remove a query to add another.</p>}
          <QueryState loading={labels.loading} error={labels.error} retry={labels.reload} />
          {labels.data && (
            <MetadataList
              key={metric}
              title="Labels"
              items={labels.data.data}
              selected={label}
              onSelect={setLabel}
            />
          )}
          <TruncationWarning truncated={labels.data?.truncated} />
        </>
      )}
      {label && (
        <>
          <p className="muted">
            Select a value for <strong className="mono">{label}</strong> to add its matcher.
          </p>
          <QueryState loading={values.loading} error={values.error} retry={values.reload} />
          {values.data && (
            <MetadataList
              key={`${metric}:${label}`}
              title="Values"
              items={values.data.data}
              onSelect={(value) => onInsert(metric, { label, value })}
            />
          )}
          <TruncationWarning truncated={values.data?.truncated} />
        </>
      )}
    </aside>
  );
}
