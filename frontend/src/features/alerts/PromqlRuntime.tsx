import { useCallback, useState } from 'react';
import { Badge, Card, EmptyState } from '../../components/ui';
import { TimeSeriesChart } from '../../components/charts/TimeSeriesChart';
import { QueryState } from '../../components/explorer/QueryState';
import { useApp } from '../../app/AppProvider';
import { useAsync } from '../../hooks/useAsync';
import { seriesLabel, toChartSeries } from '../../lib/promql';
import type { Alert, AlertTargetStatus } from '../../lib/types';
import { safeDeliveryError } from './helpers';
import { DateText } from './shared';

export function PromqlRuntime({ alert, targets }: { alert: Alert; targets: AlertTargetStatus[] }) {
  const { client } = useApp();
  const [end] = useState(() => Math.floor(Date.now() / 1000));
  const range = useAsync(
    useCallback(
      (signal) =>
        client.promqlQueryRange(
          { stream: alert.datasets[0], query: alert.query, start: end - 3600, end, step: '30s' },
          signal,
        ),
      [client, alert.datasets[0], alert.query, end],
    ),
  );
  const chart = range.data && toChartSeries(range.data, 'alert');
  const runtime = alert.promqlRuntime;
  const instances = Object.entries(runtime?.instances ?? {});
  const targetName = (id: string) =>
    targets.find(({ target }) => target.id === id)?.target.name ?? id;
  return (
    <>
      <Card className="stack">
        <h2>Expression over the last hour</h2>
        <p className="muted">
          Threshold: {alert.thresholdConfig.operator} {alert.thresholdConfig.value}. Times are UTC.
        </p>
        <QueryState loading={range.loading} error={range.error} retry={range.reload} />
        {chart && (
          <TimeSeriesChart
            {...chart}
            height={220}
            title="Alert expression"
            timeZone="UTC"
            emptyMessage="No data for this expression in the last hour."
          />
        )}
      </Card>
      <Card className="stack">
        <h2>PromQL runtime</h2>
        <p>
          Hold duration: <strong>{alert.promqlConfig?.holdDuration ?? '0s'}</strong>
        </p>
        {runtime ? (
          <>
            <div className="inline wrap">
              Evaluation health{' '}
              <Badge
                tone={
                  runtime.health === 'error'
                    ? 'danger'
                    : runtime.health === 'noData'
                      ? 'warning'
                      : 'success'
                }
              >
                {runtime.health}
              </Badge>
              <span>
                Last evaluated: <DateText value={runtime.lastEvaluatedAt} />
              </span>
            </div>
            {runtime.error && (
              <p role="alert" className="error-text">
                {safeDeliveryError(runtime.error)}
              </p>
            )}
            {instances.length ? (
              <div className="table-scroll">
                <table>
                  <caption className="sr-only">Alert instances</caption>
                  <thead>
                    <tr>
                      <th scope="col">Labels</th>
                      <th scope="col">State</th>
                      <th scope="col">Value</th>
                      <th scope="col">Pending since</th>
                    </tr>
                  </thead>
                  <tbody>
                    {instances.map(([key, instance]) => (
                      <tr key={key}>
                        <td className="alerts-labels">{seriesLabel(instance.labels)}</td>
                        <td>
                          <Badge
                            tone={
                              instance.state === 'firing'
                                ? 'danger'
                                : instance.state === 'pending'
                                  ? 'warning'
                                  : 'success'
                            }
                          >
                            {instance.state}
                          </Badge>
                        </td>
                        <td>{instance.value}</td>
                        <td>
                          <DateText value={instance.pendingSince} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <EmptyState title="No alert instances" />
            )}
            {runtime.deliveries.length > 0 && (
              <div
                className="stack"
                role={runtime.deliveries.some((delivery) => delivery.error) ? 'alert' : undefined}
              >
                <h3>Notification deliveries</h3>
                <div className="table-scroll">
                  <table>
                    <caption className="sr-only">Notification deliveries</caption>
                    <thead>
                      <tr>
                        <th scope="col">Series / state</th>
                        <th scope="col">Target</th>
                        <th scope="col">Attempts</th>
                        <th scope="col">Error</th>
                      </tr>
                    </thead>
                    <tbody>
                      {runtime.deliveries.map((delivery, index) => (
                        <tr key={`${delivery.target}-${JSON.stringify(delivery.labels)}-${index}`}>
                          <td className="alerts-labels">
                            {seriesLabel(delivery.labels)} —{' '}
                            {delivery.firing ? 'firing' : 'resolved'}
                          </td>
                          <td>{targetName(delivery.target)}</td>
                          <td>
                            {delivery.attempts} of 3{' '}
                            <Badge tone={delivery.attempts >= 3 ? 'danger' : 'warning'}>
                              {delivery.attempts >= 3 ? 'Retries exhausted' : 'Retry pending'}
                            </Badge>
                          </td>
                          <td className="alerts-labels">
                            {delivery.error
                              ? safeDeliveryError(delivery.error)
                              : 'Waiting for delivery'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </>
        ) : (
          <p className="muted">
            No runtime yet. Evaluation fills this block; editing or disabling clears it.
          </p>
        )}
        <p className="muted">
          Each series is evaluated independently. Missing data retains firing state and resets
          pending duration. Evaluation errors do not report recovery. Notifications are sent on
          firing and recovery transitions, with at most three delivery attempts.
        </p>
        {!alert.targets.length && (
          <p className="notice">
            State tracking only: no notifications until a target is selected.
          </p>
        )}
      </Card>
    </>
  );
}
