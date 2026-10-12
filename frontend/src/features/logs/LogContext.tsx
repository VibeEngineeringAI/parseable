import { useCallback, useState } from 'react';
import { useApp } from '../../app/AppProvider';
import { useAsync } from '../../hooks/useAsync';
import { Button, Select, Sheet } from '../../components/ui';
import { QueryState } from '../../components/explorer/QueryState';
import { formatTimestamp } from '../../components/explorer/timezone';
import { parseEventTimestamp } from '../../components/explorer/timestamp';
import type { LogRecord } from '../../lib/types';
import './logs-depth.css';

export function canShowContext(row: LogRecord): boolean {
  return (
    Number.isFinite(parseEventTimestamp(row.p_timestamp)) &&
    ['message', 'body', 'log'].some((field) => typeof row[field] === 'string')
  );
}

export function LogContext({
  dataset,
  row,
  timezone,
  onClose,
}: {
  dataset: string;
  row: LogRecord;
  timezone: string;
  onClose: () => void;
}) {
  const { client } = useApp();
  const [window, setWindow] = useState('5m');
  const result = useAsync(
    useCallback(
      (signal) =>
        client.logContext(
          {
            dataset,
            pTimestamp: String(row.p_timestamp),
            contextWindow: window,
            pageSize: 101,
            ...Object.fromEntries(
              ['message', 'body', 'log']
                .filter((key) => typeof row[key] === 'string')
                .slice(0, 1)
                .map((key) => [key, row[key]]),
            ),
          },
          signal,
        ),
      [client, dataset, row, window],
    ),
  );
  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="Surrounding logs"
      description="Nearby events in this dataset. Search and filters are excluded from this context window."
    >
      <div className="stack">
        <Select label="Context window" value={window} onChange={(e) => setWindow(e.target.value)}>
          <option value="1m">1 minute</option>
          <option value="5m">5 minutes</option>
          <option value="1h">1 hour</option>
        </Select>
        <QueryState loading={result.loading} error={result.error} retry={result.reload} />
        {result.data && (
          <>
            <p className="muted">
              {result.data.records.length} nearby events · {timezone}. Newest first; up to{' '}
              {result.data.limit} events.
            </p>
            {result.data.duplicateAnchorCount > 1 && (
              <p role="status" className="notice">
                {result.data.duplicateAnchorCount} events match this timestamp and message. The
                first match is highlighted.
              </p>
            )}
            <ol className="context-events" aria-label="Surrounding events">
              {result.data.records.map((record, index) => (
                <li
                  key={index}
                  aria-current={index === result.data!.anchorIndex ? 'true' : undefined}
                >
                  <details open={index === result.data!.anchorIndex}>
                    <summary>
                      {index === result.data!.anchorIndex && <strong>Selected event · </strong>}
                      {formatTimestamp(record.p_timestamp, timezone)} ·{' '}
                      {String(record.message ?? record.body ?? record.log ?? 'Event')}
                    </summary>
                    <pre className="event-json">{JSON.stringify(record, null, 2)}</pre>
                  </details>
                </li>
              ))}
            </ol>
          </>
        )}
        <Button variant="secondary" onClick={onClose}>
          Close context
        </Button>
      </div>
    </Sheet>
  );
}
