import { useState } from 'react';
import { Copy, Filter, FilterX } from 'lucide-react';
import { Button, Sheet, Input, Tabs } from '../ui';
import { formatValue } from './DataTable';
import type { LogRecord } from '../../lib/types';
export function RecordSheet({
  row,
  onClose,
  onFilter,
}: {
  row?: LogRecord;
  onClose: () => void;
  onFilter?: (field: string, value: string, operator?: '=' | '!=') => void;
}) {
  const [search, setSearch] = useState('');
  const [view, setView] = useState('fields');
  // Each opening of the sheet is a new session, even for the same event. Status
  // belongs to the session it was set in, so a copy that finishes after the
  // sheet closed or reopened is never reported, nor clears the current status.
  const [session, setSession] = useState<{ row?: LogRecord; id: object; status: string }>({
    row,
    id: {},
    status: '',
  });
  if (session.row !== row) {
    setSession({ row, id: {}, status: '' });
    setSearch('');
  }
  const report = (id: object, status: string) =>
    setSession((current) => (current.id === id ? { ...current, status } : current));
  return (
    <Sheet
      open={!!row}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="Event details"
      description="Inspect fields and values for this event."
    >
      <div className="stack">
        <Button
          variant="secondary"
          onClick={async () => {
            const { id } = session;
            try {
              await navigator.clipboard.writeText(JSON.stringify(row, null, 2));
              report(id, 'Event copied');
            } catch {
              report(id, 'Clipboard unavailable. Select the values to copy them.');
            }
          }}
        >
          <Copy size={15} />
          Copy JSON
        </Button>
        <span role="status">{session.status}</span>
        <Tabs
          value={view}
          onValueChange={setView}
          aria-label="Event view"
          items={[
            {
              value: 'fields',
              label: 'Fields',
              content: (
                <>
                  <Input
                    aria-label="Search event fields"
                    placeholder="Search fields and values"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                  <dl className="field-values">
                    {Object.entries(row || {})
                      .filter(([key, value]) =>
                        `${key} ${formatValue(value)}`.toLowerCase().includes(search.toLowerCase()),
                      )
                      .map(([key, value]) => (
                        <div key={key}>
                          <dt>{key}</dt>
                          <dd>
                            <code>{formatValue(value)}</code>
                            <div className="inline field-actions">
                              {onFilter && typeof value === 'string' && (
                                <>
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    aria-label={`Include ${key} in filter`}
                                    onClick={() => {
                                      onFilter(key, value);
                                      onClose();
                                    }}
                                  >
                                    <Filter size={13} />
                                  </Button>
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    aria-label={`Exclude ${key} from filter`}
                                    onClick={() => {
                                      onFilter(key, value, '!=');
                                      onClose();
                                    }}
                                  >
                                    <FilterX size={13} />
                                  </Button>
                                </>
                              )}
                              <Button
                                variant="ghost"
                                size="icon"
                                aria-label={`Copy key value pair ${key}`}
                                onClick={async () => {
                                  const { id } = session;
                                  try {
                                    await navigator.clipboard.writeText(
                                      `${key}: ${formatValue(value)}`,
                                    );
                                    report(id, 'Key value pair copied');
                                  } catch {
                                    report(
                                      id,
                                      'Clipboard unavailable. Select the values to copy them.',
                                    );
                                  }
                                }}
                              >
                                <Copy size={13} />
                              </Button>
                            </div>
                          </dd>
                        </div>
                      ))}
                  </dl>
                </>
              ),
            },
            {
              value: 'json',
              label: 'JSON',
              content: <pre className="event-json">{JSON.stringify(row, null, 2)}</pre>,
            },
          ]}
        />
      </div>
    </Sheet>
  );
}
