import { useCallback, useMemo, useState } from 'react';
import { AlertCircle } from 'lucide-react';
import { Badge, Button, EmptyState, Select } from '../../components/ui';
import { QueryState } from '../../components/explorer/QueryState';
import { formatValue } from '../../components/explorer/DataTable';
import { formatTimestamp } from '../../components/explorer/timezone';
import { useAsync } from '../../hooks/useAsync';
import type {
  LogRecord,
  ParseableClient,
  TraceDetailRecord,
  TraceDetailResponse,
} from '../../lib/types';
import { CopyId } from './CopyId';
import { durationMs, formatDuration, spanRecordQuery, SPAN_RECORD_LIMIT } from './helpers';

function recordKey(record: LogRecord) {
  return JSON.stringify(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
}

export function recordedEvents(records: LogRecord[]): LogRecord[] {
  const events = records
    .filter((record) => typeof record.event_name === 'string' && record.event_name.length > 0)
    .map((record) =>
      Object.fromEntries(
        Object.entries(record).filter(
          ([field, value]) => field.startsWith('event_') && value != null,
        ),
      ),
    );
  return [...new Map(events.map((event) => [recordKey(event), event])).values()];
}

export function SpanDetail({
  client,
  dataset,
  span,
  detail,
}: {
  client: ParseableClient;
  dataset: string;
  span: TraceDetailRecord;
  detail: TraceDetailResponse;
}) {
  const metadata = useAsync(
    useCallback(
      async (signal) => client.query(spanRecordQuery(dataset, span, detail), signal),
      [client, dataset, span, detail],
    ),
  );
  const [recordIndex, setRecordIndex] = useState(0);
  const records = useMemo(
    () => [...new Map((metadata.data ?? []).map((record) => [recordKey(record), record])).values()],
    [metadata.data],
  );
  const events = useMemo(() => recordedEvents(records), [records]);
  const record = records[Math.min(recordIndex, Math.max(0, records.length - 1))];
  return (
    <section className="traces-span-detail" aria-label="Span detail" data-testid="span-detail">
      <div className="traces-section-heading">
        <h2>Span detail</h2>
        <Badge tone={span.has_error ? 'danger' : 'neutral'}>
          {span.has_error && <AlertCircle size={12} aria-hidden="true" />}
          {span.has_error ? 'Error' : 'No error reported'}
        </Badge>
      </div>
      <h3 className="traces-span-detail-name">{span.span_name || 'Unnamed span'}</h3>
      <CopyId label="Copy Span ID" value={span.span_span_id} />
      <dl className="traces-facts">
        <div>
          <dt>Service</dt>
          <dd>{span['service.name']}</dd>
        </div>
        <div>
          <dt>Duration</dt>
          <dd>{formatDuration(durationMs(span.span_duration_ns))}</dd>
        </div>
        <div>
          <dt>Started (UTC)</dt>
          <dd title={span.span_start_time_unix_nano}>
            {formatTimestamp(span.span_start_time_unix_nano, 'UTC')}
          </dd>
        </div>
        <div>
          <dt>Parent span ID</dt>
          <dd>
            <code>{span.span_parent_span_id || 'Root span'}</code>
          </dd>
        </div>
        <div>
          <dt>Reported events</dt>
          <dd>{span.event_count.toLocaleString()}</dd>
        </div>
      </dl>
      <div className="traces-section-heading">
        <h3>Recorded fields</h3>
        {!metadata.loading && (
          <Button variant="ghost" size="sm" onClick={metadata.reload}>
            Reload fields
          </Button>
        )}
      </div>
      <QueryState loading={metadata.loading} error={metadata.error} retry={metadata.reload} />
      {metadata.data && !records.length && (
        <EmptyState
          title="No stored records found"
          description="The span summary remains available above."
        />
      )}
      {!!records.length && (
        <>
          {records.length > 1 && (
            <Select
              label="Stored record"
              value={Math.min(recordIndex, records.length - 1)}
              onChange={(event) => setRecordIndex(Number(event.target.value))}
            >
              {records.map((_, index) => (
                <option key={index} value={index}>
                  Record {index + 1} of {records.length}
                </option>
              ))}
            </Select>
          )}
          <dl className="traces-recorded-fields">
            {Object.entries(record ?? {})
              .filter(
                ([field]) =>
                  !field.startsWith('event_') &&
                  field !== 'span_start_time_unix_nano_epoch' &&
                  field !== 'span_end_time_unix_nano_epoch',
              )
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([field, value]) => (
                <div key={field}>
                  <dt>{field}</dt>
                  <dd>
                    <code>{formatValue(value)}</code>
                  </dd>
                </div>
              ))}
          </dl>
          <p className="muted traces-metadata-note">
            Fields come from stored records. Up to {SPAN_RECORD_LIMIT} records are queried;
            duplicate records and events are shown once.
          </p>
          {metadata.data && metadata.data.length >= SPAN_RECORD_LIMIT && (
            <p role="status" className="notice">
              This span reached the {SPAN_RECORD_LIMIT}-record display limit. Additional fields or
              events may exist.
            </p>
          )}
        </>
      )}
      <h3>Events</h3>
      {!!events.length ? (
        <ul className="traces-events">
          {events.map((event, index) => (
            <li key={recordKey(event)}>
              <h4>{String(event.event_name)}</h4>
              <dl className="traces-recorded-fields">
                {Object.entries(event)
                  .filter(([field]) => field !== 'event_name')
                  .map(([field, value]) => (
                    <div key={`${index}:${field}`}>
                      <dt>{field}</dt>
                      <dd>
                        <code>{formatValue(value)}</code>
                      </dd>
                    </div>
                  ))}
              </dl>
            </li>
          ))}
        </ul>
      ) : (
        !metadata.loading && (
          <p className="muted">
            {span.event_count
              ? 'Event payloads were not returned by the stored-record query. The native detail API provides an event count only.'
              : 'No event payloads returned.'}
          </p>
        )
      )}
    </section>
  );
}
