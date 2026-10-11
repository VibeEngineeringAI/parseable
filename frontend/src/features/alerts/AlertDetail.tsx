import { useCallback } from 'react';
import { ArrowLeft } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import { Badge, Card, CardHeader, CardBody } from '../../components/ui';
import { PageHeader } from '../../components/explorer/PageHeader';
import { QueryState } from '../../components/explorer/QueryState';
import { useApp } from '../../app/AppProvider';
import { useAsync } from '../../hooks/useAsync';
import type { Alert } from '../../lib/types';
import { AlertActions } from './AlertActions';
import { PromqlRuntime } from './PromqlRuntime';
import { muteState, queryTypeLabel, severityLabel, stateLabel } from './helpers';
import { targetType, targetTypeLabel } from './targetHelpers';
import { DateText, useAlertAccess } from './shared';

export function AlertDetail({ alert, onChanged }: { alert: Alert; onChanged: () => void }) {
  const { client } = useApp();
  const navigate = useNavigate();
  const canWrite = useAlertAccess();
  const targets = useAsync(useCallback((signal) => client.listAlertTargets(signal), [client]));
  const targetRows = targets.data ?? [];
  const mute = muteState(alert.notificationState),
    window = alert.evalConfig.rollingWindow;
  return (
    <div className="page alerts-page stack">
      <Link className="alerts-back" to="/alerts">
        <ArrowLeft size={14} aria-hidden="true" /> Back to alerts
      </Link>
      <PageHeader
        title={alert.title}
        actions={
          <AlertActions
            detail
            alert={alert}
            canWrite={canWrite}
            onChanged={onChanged}
            onDeleted={() => navigate('/alerts')}
          />
        }
      />
      <div className="inline wrap">
        <Badge
          tone={
            alert.severity === 'critical'
              ? 'danger'
              : alert.severity === 'high'
                ? 'warning'
                : 'neutral'
          }
        >
          {severityLabel(alert.severity)}
        </Badge>
        <Badge
          tone={
            alert.state === 'triggered'
              ? 'danger'
              : alert.state === 'disabled'
                ? 'neutral'
                : 'success'
          }
        >
          {stateLabel(alert.state)}
        </Badge>
        <Badge>{queryTypeLabel(alert.queryType)}</Badge>
      </div>
      {alert.state === 'disabled' && (
        <p className="notice" role="status">
          This alert is disabled. Enable it to resume evaluation and notifications.
        </p>
      )}
      <div className="alerts-detail-cards">
        <Card>
          <CardHeader>
            <h2>Rule</h2>
          </CardHeader>
          <CardBody className="stack">
            <dl>
              <dt>Dataset</dt>
              <dd>{alert.datasets.join(', ')}</dd>
            </dl>
            <pre className="alerts-query">{alert.query}</pre>
            {alert.queryType === 'builder' && (
              <p className="notice">
                Editing builder alerts is not supported yet. This SQL rule is read-only.
              </p>
            )}
          </CardBody>
        </Card>
        <Card>
          <CardHeader>
            <h2>Threshold and evaluation</h2>
          </CardHeader>
          <CardBody className="stack">
            <dl>
              <dt>Threshold</dt>
              {/* A configured value, so it is shown exactly rather than rounded. */}
              <dd>
                {alert.thresholdConfig.operator} {alert.thresholdConfig.value}
              </dd>
              <dt>Window</dt>
              <dd>{window.evalStart}</dd>
              <dt>Frequency</dt>
              <dd>
                Every {window.evalFrequency} minute{window.evalFrequency === 1 ? '' : 's'}
              </dd>
              {alert.queryType === 'promql' && (
                <>
                  <dt>Hold duration</dt>
                  <dd>{alert.promqlConfig?.holdDuration ?? '0s'}</dd>
                </>
              )}
            </dl>
          </CardBody>
        </Card>
        <Card>
          <CardHeader>
            <h2>Targets</h2>
          </CardHeader>
          <CardBody className="stack">
            <QueryState loading={targets.loading} error={targets.error} retry={targets.reload} />
            {targets.data &&
              (alert.targets.length ? (
                <ul className="alerts-target-list">
                  {alert.targets.map((id) => {
                    const row = targetRows.find(({ target }) => target.id === id);
                    return (
                      <li key={id}>
                        {row ? (
                          <>
                            <strong>{row.target.name}</strong>{' '}
                            <span className="muted">{targetTypeLabel(targetType(row.target))}</span>
                            {!row.enabled && <p className="error-text">Disabled: {row.error}</p>}
                          </>
                        ) : (
                          <span className="muted">Unavailable target {id}</span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="muted">No targets. State tracking only.</p>
              ))}
            <Link to="/alerts/targets">Manage targets</Link>
          </CardBody>
        </Card>
      </div>
      <Card>
        <CardBody>
          <dl className="alerts-metadata">
            <div>
              <dt>Created</dt>
              <dd>
                <DateText value={alert.created} />
              </dd>
            </div>
            <div>
              <dt>Last triggered</dt>
              <dd>
                <DateText value={alert.lastTriggeredAt} />
              </dd>
            </div>
            <div>
              <dt>Notification state</dt>
              <dd>{mute.label}</dd>
            </div>
            <div>
              <dt>Tags</dt>
              <dd className="alerts-tags">
                {alert.tags?.length
                  ? alert.tags.map((tag) => <Badge key={tag}>{tag}</Badge>)
                  : 'No tags'}
              </dd>
            </div>
            {alert.executionIdentity && (
              <div>
                <dt>Execution owner</dt>
                <dd>{alert.executionIdentity.userId}</dd>
              </div>
            )}
          </dl>
        </CardBody>
      </Card>
      {alert.queryType === 'promql' && <PromqlRuntime alert={alert} targets={targets.data ?? []} />}
    </div>
  );
}
