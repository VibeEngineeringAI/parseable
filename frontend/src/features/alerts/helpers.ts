import { parser } from '@prometheus-io/lezer-promql';
import { getType } from '@prometheus-io/codemirror-promql/dist/esm/parser/type';
import { parseDuration } from '../../lib/promql';
import { createId } from '../../lib/ids';
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
export const alertTypeLabel = (row: AlertSummary) =>
  row.alertType === 'threshold'
    ? queryTypeLabel(row.queryType)
    : row.alertType.charAt(0).toUpperCase() + row.alertType.slice(1);
export const stateLabel = (state: AlertSummary['state']) =>
  state === 'not-triggered' ? 'Not triggered' : state === 'triggered' ? 'Triggered' : 'Disabled';
export const severityLabel = (severity: AlertSeverity) =>
  severity[0].toUpperCase() + severity.slice(1);

// Match the server's humantime 2.3 parser, including aliases, precision and u64 limits.
export function alertDuration(value: string): number | undefined {
  if (value === '0') return 0;
  const nanosPerSecond = 1_000_000_000n;
  const max = (1n << 64n) - 1n;
  const groups: [string[], bigint][] = [
    [['ns', 'nsec', 'nanos'], 1n],
    [['us', 'usec', 'µs'], 1000n],
    [['ms', 'msec', 'millis'], 1_000_000n],
    [['s', 'sec', 'secs', 'second', 'seconds'], nanosPerSecond],
    [['m', 'min', 'mins', 'minute', 'minutes'], 60n * nanosPerSecond],
    [['h', 'hr', 'hrs', 'hour', 'hours'], 3600n * nanosPerSecond],
    [['d', 'day', 'days'], 86400n * nanosPerSecond],
    [['w', 'wk', 'wks', 'week', 'weeks'], 604800n * nanosPerSecond],
    [['M', 'month', 'months'], 2630016n * nanosPerSecond],
    [['y', 'yr', 'yrs', 'year', 'years'], 31557600n * nanosPerSecond],
  ];
  const units = new Map(
    groups.flatMap(([names, scale]) => names.map((name) => [name, scale] as const)),
  );
  let rest = value.replace(/^\p{White_Space}+/u, ''),
    total = 0n;
  if (!rest) return;
  while (rest) {
    const match = /^(\d[\d\p{White_Space}]*)(?:\.([\d\p{White_Space}]+))?([a-zA-Zµ]+)/u.exec(rest);
    if (!match) return;
    const scale = units.get(match[3]);
    if (scale === undefined) return;
    const whole = BigInt(match[1].replace(/\p{White_Space}/gu, ''));
    const wholeScale = scale < nanosPerSecond ? scale : scale / nanosPerSecond;
    if (whole > max || whole * wholeScale > max) return;
    let nanos = whole * scale;
    if (match[2] !== undefined) {
      if (scale === 1n) return; // Humantime disallows all fractional nanoseconds.
      const digits = match[2].replace(/\p{White_Space}/gu, '');
      if (!digits) return;
      const numerator = BigInt(digits);
      const denominator = 10n ** BigInt(digits.length);
      // Hours and larger units must have fractions representable as whole seconds.
      const fractionScale = scale <= 60n * nanosPerSecond ? scale : scale / nanosPerSecond;
      const product = numerator * fractionScale;
      if (denominator > max || product > max || product % denominator !== 0n) return;
      nanos += (product / denominator) * (scale <= 60n * nanosPerSecond ? 1n : nanosPerSecond);
    }
    total += nanos;
    if (total / nanosPerSecond > max) return;
    rest = rest.slice(match[0].length).replace(/^\p{White_Space}+/u, '');
  }
  return Number(total / nanosPerSecond) + Number(total % nanosPerSecond) / 1e9;
}

export type TagDraft = { id: string; value: string };
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
  tags: TagDraft[];
};
export function newAlertDraft(promql: boolean, params = new URLSearchParams()): AlertDraft {
  const handoffType = params.get('queryBuilderType');
  return {
    type: ['sql', 'code', 'builder', 'ai'].includes(handoffType ?? '')
      ? 'code'
      : promql
        ? 'promql'
        : 'code',
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
    tags: (alert.tags ?? []).map((value) => ({ id: createId(), value })),
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
  if (alertDuration(draft.window.trim()) === undefined)
    errors.window = 'Use a duration such as 10m or 1h30m.';
  if (draft.type === 'promql') {
    const hold = alertDuration(draft.hold.trim());
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
    tags: draft.tags.map(({ value }) => value).filter((value) => value.trim().length > 0),
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
        ? alertTypeLabel(row)
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
// Query type and id are immutable, so resolved types survive list reloads.
const resolvedTypes = new WeakMap<ParseableClient, Map<string, AlertQueryType>>();
export async function resolveAlertTypes(
  client: ParseableClient,
  rows: AlertSummary[],
  signal: AbortSignal,
) {
  const known = resolvedTypes.get(client) ?? new Map<string, AlertQueryType>();
  resolvedTypes.set(client, known);
  const result = rows.map((row) => ({ ...row }));
  for (const row of result) {
    if (row.queryType) known.set(row.id, row.queryType);
    else row.queryType = known.get(row.id);
  }
  const pending = result.filter((row) => !row.queryType && row.alertType === 'threshold');
  const unchecked: string[] = [];
  let next = 0;
  async function worker() {
    while (next < pending.length) {
      signal.throwIfAborted();
      const row = pending[next++];
      try {
        row.queryType = (await client.getAlert(row.id, signal)).queryType;
        known.set(row.id, row.queryType);
      } catch (error) {
        if (signal.aborted || (error instanceof Error && error.name === 'AbortError')) throw error;
        unchecked.push(row.title);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(6, pending.length) }, worker));
  return { rows: result, unchecked };
}
