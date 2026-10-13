import { useCallback, useEffect, useState, type Ref } from 'react';
import { Button, Badge, Card, CardHeader, CardBody, EmptyState } from '../../components/ui';
import { QueryState } from '../../components/explorer/QueryState';
import { useApp } from '../../app/AppProvider';
import { useAsync } from '../../hooks/useAsync';
import { parseSampleValue } from '../../lib/promql';
import { formatChartValue } from '../../components/charts/format';
import type { AlertPreviewResponse } from '../../lib/types';
import { LabelChips } from './LabelChips';
import { buildAlertPayload, compareThreshold, type AlertDraft } from './helpers';

type PreviewRow = {
  labels: Record<string, string>;
  value: number | string;
  rawValue?: string;
  breached?: boolean;
};
const previewKey = (draft: AlertDraft) =>
  JSON.stringify([
    draft.type,
    draft.dataset,
    draft.type === 'builder' ? '' : draft.query,
    draft.builderConfig,
    draft.window,
    draft.operator,
    draft.threshold,
  ]);
type PreviewResult = { rows: PreviewRow[]; engine?: AlertPreviewResponse };
export function AlertPreview({
  draft,
  disabled,
  buttonRef,
  serverPreview = false,
  onCompiled,
}: {
  draft: AlertDraft;
  disabled: boolean;
  buttonRef?: Ref<HTMLButtonElement>;
  serverPreview?: boolean;
  onCompiled?: (query: string) => void;
}) {
  const { client } = useApp();
  const [snapshot, setSnapshot] = useState<AlertDraft>();
  const draftKey = previewKey(draft);
  const activeSnapshot = !!snapshot && previewKey(snapshot) === draftKey;
  const result = useAsync(
    useCallback(
      async (signal): Promise<PreviewResult | undefined> => {
        if (!snapshot || !activeSnapshot) return;
        if (snapshot.type === 'promql') {
          const response = await client.promqlQuery(
            { stream: snapshot.dataset, query: snapshot.query },
            signal,
          );
          if (response.resultType !== 'vector')
            throw new Error('Alerts require an instant vector of numeric samples.');
          return {
            rows: response.result.map(({ metric, value }) => {
              const number = parseSampleValue(value[1]);
              if (!Number.isFinite(number))
                throw new Error('Preview requires finite numeric values.');
              return {
                labels: metric,
                value: number,
                breached: compareThreshold(number, snapshot.operator, Number(snapshot.threshold)),
              };
            }),
          };
        }
        if (serverPreview) {
          const engine = await client.previewAlert(buildAlertPayload(snapshot), signal);
          return { rows: engine.groups, engine };
        }
        if (snapshot.type === 'builder')
          throw new Error(
            'This server does not support builder preview. Save validates and compiles the rule.',
          );
        const rows = await client.query(
          { sql: snapshot.query, startTime: snapshot.window.trim(), endTime: 'now' },
          signal,
        );
        return {
          rows: rows.map((row) => {
            const values = Object.values(row).filter((value) => typeof value === 'number');
            return {
              labels: Object.fromEntries(
                Object.entries(row).map(([key, value]) => [key, String(value)]),
              ),
              value: values.map(formatChartValue).join(', ') || 'No numeric values',
              rawValue: values.join(', '),
            };
          }),
        };
      },
      [client, snapshot, serverPreview, draftKey, activeSnapshot],
    ),
  );
  useEffect(() => {
    if (activeSnapshot && result.data?.engine) onCompiled?.(result.data.engine.compiledQuery);
  }, [result.data, onCompiled, activeSnapshot]);
  const engine = result.data?.engine,
    rows = result.data?.rows,
    threshold = draft.type === 'promql' || !!engine;
  return (
    <Card className="alerts-preview">
      <CardHeader>
        <h2>Preview</h2>
      </CardHeader>
      <CardBody className="stack">
        <p className="muted">
          {draft.type === 'promql'
            ? 'Current query values and threshold comparison.'
            : serverPreview
              ? 'Server evaluation preview. It does not change alert state or send notifications.'
              : 'Query values only — threshold not evaluated. This preview never sends notifications.'}
        </p>
        <div>
          <Button
            ref={buttonRef}
            onClick={() => setSnapshot(structuredClone(draft))}
            disabled={
              disabled ||
              (draft.type === 'builder' && !serverPreview) ||
              (result.loading && activeSnapshot)
            }
          >
            {activeSnapshot && result.loading
              ? 'Previewing…'
              : draft.type === 'promql'
                ? 'Preview current values (no notifications)'
                : 'Preview SQL (no notifications)'}
          </Button>
        </div>
        {activeSnapshot && (
          <QueryState loading={result.loading} error={result.error} retry={result.reload} />
        )}
        <p role="status" className="muted alerts-status">
          {activeSnapshot && rows
            ? `Preview completed: ${rows.length ? `${rows.length} ${draft.type === 'promql' ? 'series' : 'rows'}` : 'No data'}. No notifications sent.`
            : ''}
        </p>
        {engine && (
          <div className="stack">
            <Badge tone={engine.wouldTrigger ? 'danger' : 'success'}>
              {engine.wouldTrigger ? 'Would trigger' : 'Would not trigger'}
            </Badge>
            <p className="muted">
              {engine.breachedGroups} of {engine.totalGroups} groups breach the threshold.
              {engine.noData
                ? engine.simple
                  ? ' No input data; the server evaluated the empty aggregate as zero.'
                  : ' No groups returned; nothing would trigger.'
                : ''}
              {engine.truncated ? ' Showing at most 200 groups, breached groups first.' : ''}
            </p>
            <p className="muted">
              Evaluation window: {engine.window.start} to {engine.window.end}.
            </p>
            <pre aria-label="Generated SQL" className="alerts-query">
              {engine.compiledQuery}
            </pre>
          </div>
        )}
        {activeSnapshot &&
          rows &&
          (rows.length ? (
            <div className="table-scroll" role="region" aria-label="Preview values" tabIndex={0}>
              <table>
                <caption className="sr-only">Preview values</caption>
                <thead>
                  <tr>
                    <th scope="col">{draft.type === 'promql' ? 'Series labels' : 'Result'}</th>
                    <th scope="col">Value</th>
                    {threshold && <th scope="col">Threshold</th>}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, index) => (
                    <tr key={index}>
                      <td className="alerts-labels">
                        <LabelChips labels={row.labels} />
                      </td>
                      <td title={row.rawValue ?? String(row.value)}>
                        {typeof row.value === 'number' ? formatChartValue(row.value) : row.value}
                      </td>
                      {threshold && (
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
      </CardBody>
    </Card>
  );
}
