import { useCallback, useState } from 'react';
import { useApp } from '../../app/AppProvider';
import { useAsync } from '../../hooks/useAsync';
import { Button, Select, Sheet } from '../../components/ui';
import { QueryState } from '../../components/explorer/QueryState';
import { formatTimestamp } from '../../components/explorer/timezone';
import { parseEventTimestamp } from '../../components/explorer/timestamp';
import type { LogRecord } from '../../lib/types';
import './logs-depth.css';

export function contextField(row: LogRecord): 'message' | 'body' | 'log' | undefined {
  return (['message', 'body', 'log'] as const).find((field) => typeof row[field] === 'string');
}
export function canShowContext(row: LogRecord): boolean {
  return Number.isFinite(parseEventTimestamp(row.p_timestamp)) && contextField(row) !== undefined;
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
  const [contextWindow, setContextWindow] = useState('5m');
  const field = contextField(row);
  const result = useAsync(
    useCallback(
      (signal) =>
        client.logContext(
          {
            dataset,
            pTimestamp: String(row.p_timestamp),
            contextWindow,
            pageSize: 101,
            ...(field ? { [field]: row[field] } : {}),
          },
          signal,
        ),
      [client, dataset, row, contextWindow, field],
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
        <Select
          label="Context window"
          value={contextWindow}
          onChange={(e) => setContextWindow(e.target.value)}
        >
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
                      {String(record[contextField(record) ?? ''] ?? 'Event')}
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
