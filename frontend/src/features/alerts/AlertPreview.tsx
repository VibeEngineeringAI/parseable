import { useCallback, useState, type Ref } from 'react';
import { Button, Badge, Card, EmptyState } from '../../components/ui';
import { QueryState } from '../../components/explorer/QueryState';
import { useApp } from '../../app/AppProvider';
import { useAsync } from '../../hooks/useAsync';
import { seriesLabel, parseSampleValue } from '../../lib/promql';
import { compareThreshold, type AlertDraft } from './helpers';

type PreviewRow = { labels: string; value: number | string; breached?: boolean };
export function AlertPreview({
  draft,
  disabled,
  buttonRef,
}: {
  draft: AlertDraft;
  disabled: boolean;
  buttonRef?: Ref<HTMLButtonElement>;
}) {
  const { client } = useApp();
  const [snapshot, setSnapshot] = useState<AlertDraft>();
  const result = useAsync(
    useCallback(
      async (signal): Promise<PreviewRow[] | undefined> => {
        if (!snapshot) return;
        const compare = (value: number) =>
          compareThreshold(value, snapshot.operator, Number(snapshot.threshold));
        if (snapshot.type === 'promql') {
          const response = await client.promqlQuery(
            { stream: snapshot.dataset, query: snapshot.query },
            signal,
          );
          if (response.resultType !== 'vector')
            throw new Error('Alerts require an instant vector of numeric samples.');
          return response.result.map(({ metric, value }) => {
            const number = parseSampleValue(value[1]);
            if (!Number.isFinite(number))
              throw new Error('Preview requires finite numeric values.');
            return {
              labels: seriesLabel(metric, { keepName: true }),
              value: number,
              breached: compare(number),
            };
          });
        }
        const rows = await client.query(
          { sql: snapshot.query, startTime: snapshot.window.trim(), endTime: 'now' },
          signal,
        );
        return rows.map((row) => ({
          labels: Object.entries(row)
            .map(([key, value]) => `${key}: ${String(value)}`)
            .join(', '),
          value:
            Object.values(row)
              .filter((value) => typeof value === 'number')
              .join(', ') || 'No numeric values',
        }));
      },
      [client, snapshot],
    ),
  );
  return (
    <Card className="alerts-preview stack">
      <h2>Preview</h2>
      <p className="muted">Current query values only. This preview never sends notifications.</p>
      <Button
        ref={buttonRef}
        onClick={() => setSnapshot({ ...draft, targets: [...draft.targets] })}
        disabled={disabled || (result.loading && Boolean(snapshot))}
      >
        {snapshot && result.loading
          ? 'Previewing…'
          : draft.type === 'promql'
            ? 'Preview current values (no notifications)'
            : 'Preview SQL (no notifications)'}
      </Button>
      {snapshot && (
        <QueryState loading={result.loading} error={result.error} retry={result.reload} />
      )}
      {snapshot &&
        result.data &&
        (result.data.length ? (
          <div className="table-scroll">
            <table>
              <caption className="sr-only">Preview values</caption>
              <thead>
                <tr>
                  <th scope="col">{draft.type === 'promql' ? 'Series labels' : 'Result'}</th>
                  <th scope="col">Value</th>
                  {draft.type === 'promql' && <th scope="col">Threshold</th>}
                </tr>
              </thead>
              <tbody>
                {result.data.map((row, index) => (
                  <tr key={`${row.labels}-${index}`}>
                    <td className="alerts-labels">{row.labels}</td>
                    <td>{row.value}</td>
                    {draft.type === 'promql' && (
                      <td>
                        <Badge tone={row.breached ? 'danger' : 'success'}>
                          {row.breached ? 'Threshold breached' : 'Within threshold'}
                        </Badge>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState title="No data" description="No series or rows returned for this query." />
        ))}
    </Card>
  );
}
