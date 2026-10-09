import { parser } from '@prometheus-io/lezer-promql';
import { getType } from '@prometheus-io/codemirror-promql/dist/esm/parser/type';
import { parseDuration } from '../../lib/promql';
import type {
  Alert,
  AlertQueryType,
  AlertRequest,
  AlertSeverity,
  AlertSummary,
  NotificationState,
  ParseableClient,
  ThresholdOperator,
} from '../../lib/types';

export const operators: ThresholdOperator[] = ['>', '>=', '<', '<=', '=', '!='];
export const severities: AlertSeverity[] = ['critical', 'high', 'medium', 'low'];
export const queryTypeLabel = (type?: AlertQueryType) =>
  type === 'promql'
    ? 'PromQL'
    : type === 'code'
      ? 'SQL'
      : type === 'builder'
        ? 'Builder'
        : 'Unavailable';
export const stateLabel = (state: AlertSummary['state']) =>
  state === 'not-triggered' ? 'Not triggered' : state === 'triggered' ? 'Triggered' : 'Disabled';
export const severityLabel = (severity: AlertSeverity) =>
  severity[0].toUpperCase() + severity.slice(1);

// Humantime accepts compound and long-form units, unlike Prometheus durations.
export function alertDuration(value: string): number | undefined {
  const units: Record<string, number> = {
    ns: 1e-9,
    nanos: 1e-9,
    nanosecond: 1e-9,
    nanoseconds: 1e-9,
    us: 1e-6,
    usec: 1e-6,
    microsecond: 1e-6,
    microseconds: 1e-6,
    ms: 0.001,
    msec: 0.001,
    millisecond: 0.001,
    milliseconds: 0.001,
    s: 1,
    sec: 1,
    second: 1,
    seconds: 1,
    m: 60,
    min: 60,
    minute: 60,
    minutes: 60,
    h: 3600,
    hr: 3600,
    hour: 3600,
    hours: 3600,
    d: 86400,
    day: 86400,
    days: 86400,
    w: 604800,
    week: 604800,
    weeks: 604800,
    M: 2630016,
    month: 2630016,
    months: 2630016,
    y: 31557600,
    year: 31557600,
    years: 31557600,
  };
  let rest = value.trim(),
    total = 0;
  if (!rest) return;
  while (rest) {
    const match = /^(\d+(?:\.\d+)?)\s*([a-zA-Z]+)/.exec(rest);
    if (!match || !Object.hasOwn(units, match[2])) return;
    total += Number(match[1]) * units[match[2]];
    rest = rest.slice(match[0].length).trimStart();
  }
  return Number.isFinite(total) && total <= Number.MAX_SAFE_INTEGER ? total : undefined;
}

export type AlertDraft = {
  type: 'promql' | 'code';
  dataset: string;
  query: string;
  operator: ThresholdOperator;
  threshold: string;
  frequency: string;
  window: string;
  hold: string;
  targets: string[];
  severity: AlertSeverity;
  title: string;
  tags: string[];
};
export function newAlertDraft(promql: boolean, params = new URLSearchParams()): AlertDraft {
  return {
    type: promql ? 'promql' : 'code',
    dataset: params.get('dataset') ?? '',
    query: params.get('alertQuery') ?? '',
    operator: '>',
    threshold: '0',
    frequency: '1',
    window: '10m',
    hold: '0s',
    targets: [],
    severity: 'high',
    title: params.get('title') ?? '',
    tags: [],
  };
}
export function alertDraft(alert: AlertRequest): AlertDraft {
  return {
    type: alert.queryType === 'promql' ? 'promql' : 'code',
    dataset: alert.datasets[0] ?? '',
    query: alert.query,
    operator: alert.thresholdConfig.operator,
    threshold: String(alert.thresholdConfig.value),
    frequency: String(alert.evalConfig.rollingWindow.evalFrequency),
    window: alert.evalConfig.rollingWindow.evalStart,
    hold: alert.promqlConfig?.holdDuration ?? '0s',
    targets: [...alert.targets],
    severity: alert.severity,
    title: alert.title,
    tags: [...(alert.tags ?? [])],
  };
}
export function promqlSyntaxError(query: string): string | undefined {
  const tree = parser.parse(query);
  let invalid = false,
    excessiveHistory = false;
  tree.iterate({
    enter(node) {
      if (node.type.isError) invalid = true;
      if (
        node.name === 'NumberDurationLiteralInDurationContext' &&
        (parseDuration(query.slice(node.from, node.to)) ?? 0) > 31 * 86400
      )
        excessiveHistory = true;
    },
  });
  if (invalid) return 'Enter a valid PromQL expression.';
  if (excessiveHistory) return 'PromQL selector history cannot exceed 31 days.';
  if (getType(tree.topNode.firstChild) !== 'vector')
    return 'Alerts require an instant vector of numeric samples.';
}
export function validateAlert(
  draft: AlertDraft,
  promqlEnabled: boolean,
): Partial<Record<keyof AlertDraft, string>> {
  const errors: Partial<Record<keyof AlertDraft, string>> = {};
  if (!draft.title.trim()) errors.title = 'Enter an alert title.';
  if (!draft.dataset) errors.dataset = 'Select a dataset.';
  if (!draft.query.trim()) errors.query = 'Enter a query.';
  else if (draft.type === 'promql') errors.query = promqlSyntaxError(draft.query);
  if (draft.type === 'promql' && !promqlEnabled)
    errors.type = 'PromQL alerts are not available on this server.';
  if (!operators.includes(draft.operator)) errors.operator = 'Select a threshold operator.';
  if (!draft.threshold.trim() || !Number.isFinite(Number(draft.threshold)))
    errors.threshold = 'Enter a finite threshold value.';
  const frequency = Number(draft.frequency);
  if (
    !Number.isSafeInteger(frequency) ||
    frequency < 1 ||
    (draft.type === 'promql' && frequency > 1440)
  )
    errors.frequency =
      draft.type === 'promql'
        ? 'Use 1–1440 whole minutes.'
        : 'Use a positive whole number of minutes.';
  if (alertDuration(draft.window) === undefined)
    errors.window = 'Use a duration such as 10m or 1h30m.';
  if (draft.type === 'promql') {
    const hold = alertDuration(draft.hold);
    if (hold === undefined) errors.hold = 'Use a duration such as 0s, 5m or 1h30m.';
    else if (hold > 30 * 86400) errors.hold = 'Hold duration cannot exceed 30 days.';
    if (draft.targets.length > 20)
      errors.targets = 'PromQL alerts support at most 20 notification targets.';
  }
  return Object.fromEntries(Object.entries(errors).filter(([, error]) => error));
}
const managedFields = new Set([
  'version',
  'id',
  'title',
  'severity',
  'query',
  'queryType',
  'datasets',
  'alertType',
  'thresholdConfig',
  'evalConfig',
  'notificationConfig',
  'targets',
  'tags',
  'state',
  'notificationState',
  'created',
  'lastTriggeredAt',
  'anomalyConfig',
  'forecastConfig',
  'promqlRuntime',
  'executionIdentity',
  'promqlConfig',
]);
export function buildAlertPayload(draft: AlertDraft, original?: AlertRequest): AlertRequest {
  const extra = Object.fromEntries(
    Object.entries(original ?? {}).filter(([key]) => !managedFields.has(key)),
  );
  return {
    ...extra,
    title: draft.title.trim(),
    severity: draft.severity,
    query: draft.query.trim(),
    queryType: draft.type,
    datasets: [draft.dataset],
    alertType: 'threshold',
    thresholdConfig: { operator: draft.operator, value: Number(draft.threshold) },
    evalConfig: {
      rollingWindow: {
        evalStart: draft.window.trim(),
        evalEnd: 'now',
        evalFrequency: Number(draft.frequency),
      },
    },
    notificationConfig: {
      interval:
        draft.type === 'promql'
          ? 1
          : Math.min(original?.notificationConfig.interval ?? 1, Number(draft.frequency)),
    },
    targets: [...draft.targets],
    tags: [...draft.tags],
    ...(draft.type === 'promql'
      ? { promqlConfig: { ...original?.promqlConfig, holdDuration: draft.hold.trim() } }
      : {}),
  };
}

export function compareThreshold(
  value: number,
  operator: ThresholdOperator,
  threshold: number,
): boolean | undefined {
  if (!Number.isFinite(value) || !Number.isFinite(threshold)) return;
  switch (operator) {
    case '>':
      return value > threshold;
    case '>=':
      return value >= threshold;
    case '<':
      return value < threshold;
    case '<=':
      return value <= threshold;
    case '=':
      return value === threshold;
    case '!=':
      return value !== threshold;
  }
}
export function muteState(
  state: NotificationState,
  now = Date.now(),
): { muted: boolean; label: string } {
  const value = typeof state === 'string' ? state : state.mute;
  if (value === 'notify') return { muted: false, label: 'Notifications on' };
  if (value === 'indefinite' || /^\+?262142-/.test(value))
    return { muted: true, label: 'Muted indefinitely' };
  const date = Date.parse(value);
  if (Number.isFinite(date))
    return date > now
      ? {
          muted: true,
          label: `Muted until ${formatAlertDate(value)}`,
        }
      : { muted: false, label: 'Notifications on' };
  return { muted: true, label: 'Muted (unknown end time)' };
}
export function utcMuteDate(value: string, now = Date.now()): { state?: string; error?: string } {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(value))
    return { error: 'Choose a UTC date and time.' };
  const time = Date.parse(`${value}Z`);
  if (Number.isFinite(time) && new Date(time).toISOString().slice(0, value.length) !== value)
    return { error: 'Choose a valid UTC date and time.' };
  if (!Number.isFinite(time) || time <= now) return { error: 'Choose a future UTC date and time.' };
  return { state: new Date(time).toISOString() };
}
export function displayDate(value?: string | null) {
  if (!value) return undefined;
  const iso = value.includes(' UTC') ? value.replace(' ', 'T').replace(' UTC', 'Z') : value;
  return Number.isFinite(Date.parse(iso)) ? new Date(iso).toISOString() : undefined;
}
export function formatAlertDate(value: string) {
  const iso = displayDate(value);
  return iso ? `${iso.slice(0, 19).replace('T', ' ')} UTC` : 'Never';
}
// Reqwest errors may embed credential-bearing target URLs.
export const safeDeliveryError = (value: string) =>
  value.replace(/https?:\/\/[^\s)"'<>]+/gi, '[redacted endpoint]').slice(0, 500);

export type AlertSort = 'title' | 'severity' | 'state' | 'type' | 'dataset' | 'tags';
export function filterSortAlerts(
  rows: AlertSummary[],
  search: string,
  tag: string,
  sort: AlertSort,
  descending: boolean,
) {
  const key = (row: AlertSummary) =>
    sort === 'severity'
      ? String(severities.indexOf(row.severity))
      : sort === 'type'
        ? queryTypeLabel(row.queryType)
        : sort === 'dataset'
          ? row.datasets.join(', ')
          : sort === 'tags'
            ? (row.tags ?? []).join(', ')
            : row[sort];
  return rows
    .filter(
      (row) =>
        row.title.toLowerCase().includes(search.toLowerCase()) && (!tag || row.tags?.includes(tag)),
    )
    .sort(
      (a, b) => (key(a).localeCompare(key(b)) || a.id.localeCompare(b.id)) * (descending ? -1 : 1),
    );
}
export async function resolveAlertTypes(
  client: ParseableClient,
  rows: AlertSummary[],
  signal: AbortSignal,
) {
  const result = rows.map((row) => ({ ...row }));
  const unchecked: string[] = [];
  let next = 0;
  async function worker() {
    while (next < result.length) {
      signal.throwIfAborted();
      const row = result[next++];
      if (row.queryType) continue;
      try {
        row.queryType = (await client.getAlert(row.id, signal)).queryType;
      } catch (error) {
        if (signal.aborted || (error instanceof Error && error.name === 'AbortError')) throw error;
        unchecked.push(row.title);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(6, rows.length) }, worker));
  return { rows: result, unchecked };
}
