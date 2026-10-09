import { ApiError } from './client';
import { createId } from './ids';
import {
  alertDraft,
  buildAlertPayload,
  compareThreshold,
  newAlertDraft,
  validateAlert,
  alertDuration,
} from '../features/alerts/helpers';
import { targetDraft, validateTarget } from '../features/alerts/targetHelpers';
import type {
  Alert,
  AlertRequest,
  AlertSummary,
  AlertTarget,
  AlertTargetRequest,
  AlertTargetStatus,
  ParseableClient,
} from './types';

type Methods =
  | 'listAlerts'
  | 'getAlert'
  | 'createAlert'
  | 'updateAlert'
  | 'deleteAlert'
  | 'enableAlert'
  | 'disableAlert'
  | 'muteAlert'
  | 'evaluateAlert'
  | 'listAlertTags'
  | 'listAlertTargets'
  | 'getAlertTarget'
  | 'createAlertTarget'
  | 'updateAlertTarget'
  | 'deleteAlertTarget';
const clone = <T>(value: T): T => structuredClone(value);
const fail = (message: string, status = 400): never => {
  throw new ApiError(message, status);
};

export function createDemoAlerts(now = Date.now()): Pick<ParseableClient, Methods> {
  const created = new Date(now - 86400_000).toISOString();
  const target1 = '01M4H000000000000000000001',
    target2 = '01M4H000000000000000000002';
  let targets: AlertTargetStatus[] = [
    {
      target: {
        id: target1,
        name: 'Operations Slack',
        type: 'slack',
        endpoint: 'https://********',
      },
      enabled: true,
    },
    {
      target: {
        id: target2,
        name: 'Incident webhook',
        type: 'webhook',
        endpoint: 'https://********',
        headers: { 'X-Source': '********' },
        skipTlsCheck: false,
      },
      enabled: false,
      error: 'Private target is not allowed by outbound policy',
    },
  ];
  const seed = (
    id: string,
    title: string,
    queryType: Alert['queryType'],
    muted = false,
  ): Alert => ({
    ...buildAlertPayload({
      ...newAlertDraft(queryType === 'promql'),
      title,
      query:
        queryType === 'promql'
          ? '{__name__="system.cpu.load_average.1m"}'
          : 'SELECT COUNT(*) FROM "application_logs" WHERE level = \'ERROR\'',
      dataset: queryType === 'promql' ? 'demo_metrics' : 'application_logs',
      threshold: queryType === 'promql' ? '1' : '5',
      frequency: queryType === 'promql' ? '1' : '5',
      targets: [target1],
      tags: queryType === 'promql' ? ['production', 'metrics'] : ['production', 'logs'],
      hold: '5m',
    }),
    queryType,
    version: 'v2',
    id,
    created,
    state: 'not-triggered',
    notificationState: muted ? { mute: 'indefinite' } : 'notify',
    lastTriggeredAt: null,
  });
  let alerts: Alert[] = [
    seed('01M4H000000000000000000010', 'High host load', 'promql'),
    seed('01M4H000000000000000000011', 'Application errors', 'code'),
    seed('01M4H000000000000000000012', 'Checkout errors (builder)', 'builder'),
    seed('01M4H000000000000000000013', 'Muted memory warning', 'promql', true),
  ];
  alerts[0].state = 'triggered';
  alerts[0].lastTriggeredAt = new Date(now - 120_000).toISOString();
  alerts[0].promqlRuntime = {
    health: 'ok',
    error: null,
    lastEvaluatedAt: new Date(now - 10_000).toISOString(),
    instances: {
      '{"host":"node-03"}': {
        labels: { host: 'node-03' },
        state: 'firing',
        value: 1.62,
        pendingSince: new Date(now - 420_000).toISOString(),
        lastSeen: new Date(now - 10_000).toISOString(),
      },
      '{"host":"node-01"}': {
        labels: { host: 'node-01' },
        state: 'resolved',
        value: 0.75,
        pendingSince: null,
        lastSeen: new Date(now - 10_000).toISOString(),
      },
    },
    deliveries: [
      {
        labels: { host: 'node-03' },
        value: 1.62,
        firing: true,
        target: target1,
        attempts: 2,
        error: 'Notification delivery failed (503 Service Unavailable)',
      },
    ],
  };
  alerts[3].query = '{__name__="process.memory.usage"}';
  alerts[3].thresholdConfig.value = 400_000_000;
  alerts[3].targets = [];
  const get = (id: string) =>
    alerts.find((item) => item.id === id) ?? fail(`Alert with ID- ${id} not found`);
  const getTarget = (id: string) =>
    targets.find((item) => item.target.id === id) ?? fail(`Invalid Target ID- ${id}`);
  async function ready(signal?: AbortSignal) {
    signal?.throwIfAborted();
    await Promise.resolve();
    signal?.throwIfAborted();
  }
  function validate(body: AlertRequest) {
    const errors = validateAlert(alertDraft(body), true);
    if (Object.keys(errors).length) fail(Object.values(errors)[0]!);
    if (
      body.notificationConfig.interval < 1 ||
      body.notificationConfig.interval > body.evalConfig.rollingWindow.evalFrequency
    )
      fail('Notification interval cannot exceed evaluation frequency');
    body.targets.forEach(getTarget);
    if (
      !body.datasets.length ||
      body.datasets.some(
        (dataset) =>
          !['demo_metrics', 'application_logs', 'api_logs', 'infrastructure_logs'].includes(
            dataset,
          ),
      )
    )
      fail('Invalid alert dataset');
    if (
      body.queryType === 'promql' &&
      (body.datasets.length !== 1 || body.datasets[0] !== 'demo_metrics')
    )
      fail('PromQL requires the demo_metrics metrics dataset.');
    if (body.queryType !== 'promql') {
      const sql = body.query.replace(/'(?:''|[^'])*'|--[^\n]*|\/\*[\s\S]*?\*\//g, ' ');
      if ([...sql.matchAll(/\b(count|sum|avg|min|max)\s*\(/gi)].length !== 1)
        fail('SQL alerts require one numeric aggregate expression.');
      if ((sql.match(/\bselect\b/gi) ?? []).length > 1) fail('Subquery not allowed');
    }
  }
  function mask(body: AlertTargetRequest, id: string): AlertTarget {
    const endpoint = `${new URL(body.endpoint).protocol}//********`;
    if (body.type === 'slack') return { id, name: body.name, type: 'slack', endpoint };
    if (body.type === 'alertManager')
      return {
        id,
        name: body.name,
        type: 'webhook',
        endpoint,
        username: body.username ?? null,
        password: body.password ? '********' : null,
        skipTlsCheck: body.skipTlsCheck,
      };
    return {
      id,
      name: body.name,
      type: 'webhook',
      endpoint,
      headers: Object.fromEntries(Object.keys(body.headers ?? {}).map((key) => [key, '********'])),
      skipTlsCheck: body.skipTlsCheck,
    };
  }
  function validateTargetBody(body: AlertTargetRequest) {
    const draft = {
      ...targetDraft(),
      ...body,
      username: body.type === 'alertManager' ? (body.username ?? '') : '',
      password: body.type === 'alertManager' ? (body.password ?? '') : '',
      headers:
        body.type === 'webhook'
          ? Object.entries(body.headers ?? {}).map(([key, value]) => ({
              id: createId(),
              key,
              value,
            }))
          : [],
    };
    const errors = validateTarget(draft);
    if (Object.keys(errors).length) fail(Object.values(errors)[0]!);
    if (body.type !== 'slack' && body.skipTlsCheck) fail('TLS verification cannot be disabled');
    const host = new URL(body.endpoint).hostname;
    if (['localhost', '127.0.0.1', '[::1]'].includes(host))
      fail('Private target is not allowed by outbound policy');
  }
  return {
    async listAlerts(signal) {
      await ready(signal);
      return clone(
        alerts.map((item): AlertSummary => ({
          id: item.id,
          title: item.title,
          severity: item.severity,
          state: item.state,
          alertType: item.alertType,
          datasets: item.datasets,
          created: item.created,
          notificationState: item.notificationState,
          tags: item.tags,
          lastTriggeredAt: item.lastTriggeredAt,
          ...(item.promqlConfig ? { promqlConfig: item.promqlConfig } : {}),
        })),
      );
    },
    async getAlert(id, signal) {
      await ready(signal);
      return clone(get(id));
    },
    async createAlert(body) {
      await ready();
      validate(body);
      const value: Alert = {
        ...clone(body),
        version: 'v2',
        id: createId(),
        state: 'not-triggered',
        notificationState: 'notify',
        created: new Date().toISOString(),
        lastTriggeredAt: null,
      };
      alerts.push(value);
      return clone(value);
    },
    async updateAlert(id, body) {
      await ready();
      const previous = get(id);
      validate(body);
      const value: Alert = {
        ...clone(body),
        version: previous.version,
        id,
        state: previous.state,
        notificationState: previous.notificationState,
        created: previous.created,
        lastTriggeredAt: previous.lastTriggeredAt,
      };
      alerts = alerts.map((item) => (item.id === id ? value : item));
      return clone(value);
    },
    async deleteAlert(id) {
      await ready();
      get(id);
      alerts = alerts.filter((item) => item.id !== id);
    },
    async enableAlert(id) {
      await ready();
      const value = get(id);
      if (value.state !== 'disabled') fail("Can't enable an alert which is not currently disabled");
      value.state = 'not-triggered';
      return clone(value);
    },
    async disableAlert(id) {
      await ready();
      const value = get(id);
      if (value.state === 'disabled') fail("Can't disable an alert which is currently disabled");
      value.state = 'disabled';
      delete value.promqlRuntime;
      return clone(value);
    },
    async muteAlert(id, state) {
      await ready();
      const value = get(id);
      if (state === 'notify') value.notificationState = 'notify';
      else if (state === 'indefinite') value.notificationState = { mute: 'indefinite' };
      else {
        const duration = alertDuration(state),
          time = duration !== undefined ? Date.now() + duration * 1000 : Date.parse(state);
        if (!Number.isFinite(time) || time < Date.now()) fail('Choose a future UTC date and time.');
        value.notificationState = { mute: new Date(time).toISOString() };
      }
      return clone(value);
    },
    async evaluateAlert(id) {
      await ready();
      const value = get(id);
      if (value.state === 'disabled') fail('Enable this alert before evaluating it.');
      if (value.queryType === 'promql')
        value.promqlRuntime = value.promqlRuntime ?? {
          health: 'noData',
          error: null,
          lastEvaluatedAt: new Date().toISOString(),
          instances: {},
          deliveries: [],
        };
      else {
        value.state = compareThreshold(
          8,
          value.thresholdConfig.operator,
          value.thresholdConfig.value,
        )
          ? 'triggered'
          : 'not-triggered';
      }
      return clone(value);
    },
    async listAlertTags(signal) {
      await ready(signal);
      return [...new Set(alerts.flatMap((item) => item.tags ?? []))].sort();
    },
    async listAlertTargets(signal) {
      await ready(signal);
      return clone(targets);
    },
    async getAlertTarget(id, signal) {
      await ready(signal);
      return clone(getTarget(id));
    },
    async createAlertTarget(body) {
      await ready();
      validateTargetBody(body);
      const target = mask(body, createId());
      targets.push({ target, enabled: true });
      return clone(target);
    },
    async updateAlertTarget(id, body) {
      await ready();
      const previous = getTarget(id);
      if (body.name !== previous.target.name) fail("Can't modify target name");
      validateTargetBody(body);
      previous.target = mask(body, id);
      previous.enabled = true;
      delete previous.error;
      return clone(previous.target);
    },
    async deleteAlertTarget(id) {
      await ready();
      const value = getTarget(id);
      if (alerts.some((item) => item.targets.includes(id)))
        fail("Can't delete a Target which is being used", 409);
      targets = targets.filter((item) => item.target.id !== id);
      return clone(value.target);
    },
  };
}
