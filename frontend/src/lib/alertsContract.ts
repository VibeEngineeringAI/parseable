import { object, strings } from './teamContract';
import type {
  Alert,
  AlertSummary,
  AlertTarget,
  AlertTargetStatus,
  NotificationState,
  PromqlAlertRuntime,
} from './types';

const oneOf = (value: unknown, choices: string[]) =>
  typeof value === 'string' && choices.includes(value);
const finite = (value: unknown) => typeof value === 'number' && Number.isFinite(value);
const nullableString = (value: unknown) => value === null || typeof value === 'string';
const labels = (value: unknown) =>
  object(value) && Object.values(value).every((item) => typeof item === 'string');
export function notificationState(value: unknown): value is NotificationState {
  return typeof value === 'string' || (object(value) && typeof value.mute === 'string');
}
export function promqlRuntime(value: unknown): value is PromqlAlertRuntime {
  return (
    object(value) &&
    oneOf(value.health, ['ok', 'noData', 'error']) &&
    nullableString(value.error) &&
    nullableString(value.lastEvaluatedAt) &&
    object(value.instances) &&
    Object.values(value.instances).every(
      (instance) =>
        object(instance) &&
        labels(instance.labels) &&
        oneOf(instance.state, ['pending', 'firing', 'resolved']) &&
        nullableString(instance.pendingSince) &&
        typeof instance.lastSeen === 'string' &&
        finite(instance.value),
    ) &&
    Array.isArray(value.deliveries) &&
    value.deliveries.every(
      (delivery) =>
        object(delivery) &&
        labels(delivery.labels) &&
        finite(delivery.value) &&
        typeof delivery.firing === 'boolean' &&
        typeof delivery.target === 'string' &&
        Number.isInteger(delivery.attempts) &&
        (delivery.attempts as number) >= 0 &&
        nullableString(delivery.error),
    )
  );
}
function extras(value: Record<string, unknown>) {
  return (
    (value.promqlConfig === undefined ||
      (object(value.promqlConfig) &&
        (value.promqlConfig.holdDuration === undefined ||
          typeof value.promqlConfig.holdDuration === 'string'))) &&
    (value.promqlRuntime === undefined || promqlRuntime(value.promqlRuntime)) &&
    (value.executionIdentity === undefined ||
      (object(value.executionIdentity) &&
        typeof value.executionIdentity.userId === 'string' &&
        typeof value.executionIdentity.tenantId === 'string'))
  );
}
export function alertSummary(value: unknown): value is Omit<AlertSummary, 'severity'> &
  Record<string, unknown> & {
    severity: AlertSummary['severity'] | Capitalize<AlertSummary['severity']>;
  } {
  return (
    object(value) &&
    ['id', 'title', 'created'].every((key) => typeof value[key] === 'string') &&
    oneOf(value.severity, [
      'critical',
      'high',
      'medium',
      'low',
      'Critical',
      'High',
      'Medium',
      'Low',
    ]) &&
    oneOf(value.state, ['triggered', 'not-triggered', 'disabled']) &&
    typeof value.alertType === 'string' &&
    value.alertType !== '' &&
    strings(value.datasets) &&
    notificationState(value.notificationState) &&
    (value.tags == null || strings(value.tags)) &&
    (value.lastTriggeredAt == null || typeof value.lastTriggeredAt === 'string') &&
    (value.queryType === undefined || oneOf(value.queryType, ['promql', 'code', 'builder'])) &&
    extras(value)
  );
}
export function alert(value: unknown): value is Alert {
  if (!alertSummary(value) || !object(value)) return false;
  const threshold = value.thresholdConfig;
  const evaluation = value.evalConfig;
  const notification = value.notificationConfig;
  const window = object(evaluation) ? evaluation.rollingWindow : undefined;
  return (
    value.alertType === 'threshold' &&
    typeof value.version === 'string' &&
    typeof value.query === 'string' &&
    oneOf(value.severity, ['critical', 'high', 'medium', 'low']) &&
    oneOf(value.queryType, ['promql', 'code', 'builder']) &&
    object(threshold) &&
    oneOf(threshold.operator, ['>', '<', '=', '!=', '>=', '<=']) &&
    finite(threshold.value) &&
    object(window) &&
    typeof window.evalStart === 'string' &&
    typeof window.evalEnd === 'string' &&
    Number.isSafeInteger(window.evalFrequency) &&
    (window.evalFrequency as number) >= 1 &&
    object(notification) &&
    Number.isSafeInteger(notification.interval) &&
    (notification.interval as number) >= 1 &&
    strings(value.targets) &&
    nullableString(value.lastTriggeredAt)
  );
}
export function alertTarget(value: unknown): value is AlertTarget {
  return (
    object(value) &&
    ['id', 'name', 'endpoint'].every((key) => typeof value[key] === 'string') &&
    oneOf(value.type, ['slack', 'webhook', 'alertManager']) &&
    (value.headers === undefined || labels(value.headers)) &&
    (value.skipTlsCheck === undefined || typeof value.skipTlsCheck === 'boolean') &&
    (value.username === undefined || nullableString(value.username)) &&
    (value.password === undefined || nullableString(value.password))
  );
}
export function alertTargetStatus(value: unknown): value is AlertTargetStatus {
  return (
    object(value) &&
    alertTarget(value.target) &&
    typeof value.enabled === 'boolean' &&
    (value.error === undefined || typeof value.error === 'string')
  );
}
