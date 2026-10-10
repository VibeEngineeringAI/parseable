import { useCallback, useEffect, useMemo, useState } from 'react';
import { Badge, Card, CardHeader, CardBody } from '../../components/ui';
import { formatChartValue } from '../../components/charts/format';
import { TimeSeriesChart } from '../../components/charts/TimeSeriesChart';
import { QueryState } from '../../components/explorer/QueryState';
import { useApp } from '../../app/AppProvider';
import { useAsync } from '../../hooks/useAsync';
import { toChartSeries, varyingLabelKeys } from '../../lib/promql';
import type { Alert, AlertTargetStatus } from '../../lib/types';
import { safeDeliveryError } from './helpers';
import { DateText } from './shared';
import { LabelChips } from './LabelChips';

export function PromqlRuntime({ alert, targets }: { alert: Alert; targets: AlertTargetStatus[] }) {
  const { client } = useApp();
  // The window ends when the expression loads and moves only when the dataset or query changes,
  // so unrelated reloads such as Mute keep the chart; the last chart stays up while it loads.
  const end = useMemo(() => Math.floor(Date.now() / 1000), [alert.datasets[0], alert.query]);
  const range = useAsync(
    useCallback(
      async (signal) => ({
        end,
        data: await client.promqlQueryRange(
          { stream: alert.datasets[0], query: alert.query, start: end - 3600, end, step: '30s' },
          signal,
        ),
      }),
      [client, alert.datasets[0], alert.query, end],
    ),
  );
  const [last, setLast] = useState(range.data);
  useEffect(() => {
    if (range.data || range.error) setLast(range.data);
  }, [range.data, range.error]);
  const shown = range.data ?? last;
  const chart = useMemo(() => {
    if (!shown) return;
    const chart = toChartSeries(shown.data);
    const varying = varyingLabelKeys(chart.series.map((series) => series.metric));
    const series = chart.series.map((series) => {
      const labels = series.metric;
      const name = varying.length
        ? varying
            .map((key) => labels[key])
            .filter(Boolean)
            .join(' · ')
        : (labels.host ??
          labels['host.name'] ??
          labels.instance ??
          Object.entries(labels)
            .filter(([key]) => key !== '__name__')
            .map(([, value]) => value)
            .join(' · '));
      return { ...series, label: name || labels.__name__ || 'Expression' };
    });
    return { ...chart, series, xRange: [shown.end - 3600, shown.end] as const };
  }, [shown]);
  const thresholds = useMemo(
    () => [{ value: alert.thresholdConfig.value, label: 'Threshold' }],
    [alert.thresholdConfig.value],
  );
  const runtime = alert.promqlRuntime;
  const instances = Object.entries(runtime?.instances ?? {});
  const targetName = (id: string) =>
    targets.find(({ target }) => target.id === id)?.target.name ?? id;
  return (
    <>
      <Card>
        <CardHeader>
          <h2>Expression over the last hour</h2>
        </CardHeader>
        <CardBody className="stack">
          <p className="muted">
            Threshold: {alert.thresholdConfig.operator}{' '}
            {formatChartValue(alert.thresholdConfig.value)}. Times are UTC.
          </p>
          <QueryState loading={range.loading && !shown} error={range.error} retry={range.reload} />
          {chart && (
            <TimeSeriesChart
              {...chart}
              height={220}
              title="Expression over the last hour"
              showTitle={false}
              thresholds={thresholds}
              timeZone="UTC"
              emptyMessage="No data for this expression in the last hour."
            />
          )}
        </CardBody>
      </Card>
      <Card>
        <CardHeader>
          <h2>PromQL runtime</h2>
        </CardHeader>
        <CardBody className="stack">
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
                  {{ ok: 'OK', noData: 'No data', error: 'Error' }[runtime.health]}
                </Badge>
                <span data-testid="last-evaluated">
                  Last evaluated: <DateText value={runtime.lastEvaluatedAt} />
                </span>
              </div>
              {runtime.error && (
                <p role="alert" className="error-text">
                  {safeDeliveryError(runtime.error)}
                </p>
              )}
              {instances.length ? (
                <div
                  className="table-scroll"
                  role="region"
                  aria-label="Alert instances"
                  tabIndex={0}
                >
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
                          <td className="alerts-labels">
                            <LabelChips labels={instance.labels} />
                          </td>
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
                              {
                                { pending: 'Pending', firing: 'Firing', resolved: 'Resolved' }[
                                  instance.state
                                ]
                              }
                            </Badge>
                          </td>
                          <td title={String(instance.value)}>{formatChartValue(instance.value)}</td>
                          <td>
                            <DateText value={instance.pendingSince} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="muted">No alert instances</p>
              )}
              {runtime.deliveries.length > 0 && (
                <div className="stack">
                  <h3>Notification deliveries</h3>
                  {runtime.deliveries.some((delivery) => delivery.error) && (
                    <p className="error-text">
                      Some notifications could not be delivered. Check the attempts and errors
                      below.
                    </p>
                  )}
                  <div
                    className="table-scroll"
                    role="region"
                    aria-label="Notification deliveries"
                    tabIndex={0}
                  >
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
                          <tr
                            key={`${delivery.target}-${JSON.stringify(delivery.labels)}-${index}`}
                          >
                            <td className="alerts-labels">
                              <LabelChips labels={delivery.labels} />
                              <span>{delivery.firing ? 'Firing' : 'Resolved'}</span>
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
        </CardBody>
      </Card>
    </>
  );
}
