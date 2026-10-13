import { ApiError } from './client';
import { sqlBuilderConfig, demoCompileSqlBuilder, sqlFieldType } from './sqlBuilderContract';
import type { SqlBuilderV1 } from './sqlBuilderContract';
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
  | 'previewAlert'
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

export function createDemoAlerts(
  now = Date.now(),
  datasets?: Pick<ParseableClient, 'datasetSchema' | 'listDatasets'>,
  records: import('./types').LogRecord[] = [],
): Pick<ParseableClient, Methods> {
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
      tags: (queryType === 'promql' ? ['production', 'metrics'] : ['production', 'logs']).map(
        (value) => ({ id: createId(), value }),
      ),
      hold: '5m',
    }),
    queryType,
    ...(queryType !== 'promql'
      ? { executionMode: 'server' as const }
      : { executionMode: 'owner' as const, executionOwner: 'Demo user' }),
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
  async function normalize(
    body: AlertRequest,
    previous?: Alert,
    preview = false,
  ): Promise<AlertRequest> {
    const normalized = clone(body);
    for (const key of [
      'executionOwner',
      'executionMode',
      'executionIdentity',
      'builderStatus',
      'sqlRuntime',
    ])
      delete normalized[key];
    if (body.builderConfig != null) {
      if (body.queryType === 'code') fail('Omit builderConfig to convert to SQL.', 409);
      if (body.queryType !== 'builder' || !sqlBuilderConfig(body.builderConfig))
        fail('Unsupported or invalid builderConfig');
      const spec = clone(body.builderConfig as SqlBuilderV1);
      if (datasets) {
        if (!(await datasets.listDatasets()).some((item) => item.name === spec.dataset))
          fail('Invalid alert dataset');
        const schema = await datasets.datasetSchema(spec.dataset);
        const getField = (name: string) =>
          schema.fields.find((field) => field.name === name) ??
          fail(`Unknown builder column: ${name}`);
        if (spec.aggregate.column) {
          const field = getField(spec.aggregate.column);
          if (
            spec.aggregate.function !== 'count' &&
            !['int', 'float'].includes(sqlFieldType(field) ?? '')
          )
            fail('Aggregate requires a numeric column');
        }
        for (const name of spec.groupBy ?? [])
          if (!['int', 'string', 'boolean'].includes(sqlFieldType(getField(name)) ?? ''))
            fail('Unsupported groupBy type');
        const normalizeGroup = (group: import('./types').LogContextConditions) => {
          for (const condition of group.conditionConfig ?? []) {
            const type = sqlFieldType(getField(condition.column));
            if (!type) fail('Unsupported filter field type');
            condition.type = type;
          }
          for (const child of group.groups ?? []) normalizeGroup(child);
        };
        if (spec.filters) normalizeGroup(spec.filters);
      }
      if (!sqlBuilderConfig(spec)) fail('Invalid builder filter literal');
      const query = demoCompileSqlBuilder(spec);
      if (body.query.trim() && body.query.trim() !== query)
        fail(
          'BuilderConflict: query does not match builderConfig; convert to SQL to edit the query directly.',
          409,
        );
      normalized.query = query;
      normalized.builderConfig = spec;
      normalized.datasets = [spec.dataset];
    } else if (previous?.builderConfig && body.queryType === 'builder')
      fail(
        'BuilderConflict: a stored specification cannot be omitted without converting to SQL.',
        409,
      );
    const errors = validateAlert(alertDraft(normalized), true);
    if (preview) delete errors.title;
    if (Object.keys(errors).length) fail(Object.values(errors)[0]!);
    return normalized;
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
      (!body.builderConfig &&
        body.datasets.some(
          (dataset) =>
            !['demo_metrics', 'application_logs', 'api_logs', 'infrastructure_logs'].includes(
              dataset,
            ),
        ))
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

  function previewBuilder(spec: SqlBuilderV1, body: AlertRequest) {
    const testCondition = (
      item: NonNullable<import('./types').LogContextConditions['conditionConfig']>[number],
      row: import('./types').LogRecord,
    ): boolean => {
      const value = row[item.column],
        target = item.value ?? '',
        op = item.operator;
      if (op === 'is null') return value == null;
      if (op === 'is not null') return value != null;
      if (value == null) return false;
      const comparison =
        item.type === 'int' || item.type === 'float'
          ? Number(target)
          : item.type === 'boolean'
            ? target === 'true'
            : target;
      if (op === '=') return value === comparison;
      if (op === '!=') return value !== comparison;
      const left = typeof comparison === 'number' ? Number(value) : String(value),
        right = typeof comparison === 'number' ? comparison : String(comparison);
      if (op === '<') return left < right;
      if (op === '>') return left > right;
      if (op === '<=') return left <= right;
      if (op === '>=') return left >= right;
      const text = String(value).toLowerCase(),
        needle = target.toLowerCase();
      let matched = op.includes('begin')
        ? text.startsWith(needle)
        : op.includes('end')
          ? text.endsWith(needle)
          : op === 'ilike'
            ? text.includes(needle.replaceAll('%', ''))
            : text.includes(needle);
      if (Array.isArray(value)) matched = value.includes(target);
      return op.startsWith('does not') ? !matched : matched;
    };
    const matchGroup = (
      group: import('./types').LogContextConditions,
      row: import('./types').LogRecord,
    ): boolean => {
      const results = [
        ...(group.conditionConfig ?? []).map((condition) => testCondition(condition, row)),
        ...(group.groups ?? []).map((child) => matchGroup(child, row)),
      ];
      return (
        !results.length ||
        (group.operator === 'or' ? results.some(Boolean) : results.every(Boolean))
      );
    };
    const source = ['application_logs', 'api_logs', 'infrastructure_logs'].includes(spec.dataset)
      ? records
      : [];
    const eligible = source.filter((row) => !spec.filters || matchGroup(spec.filters, row));
    const grouped = new Map<
      string,
      { labels: Record<string, string>; rows: import('./types').LogRecord[] }
    >();
    if (!spec.groupBy?.length) grouped.set('{}', { labels: {}, rows: [] });
    for (const row of eligible) {
      const labels = Object.fromEntries(
          (spec.groupBy ?? []).map((name) => [name, String(row[name] ?? 'null')]),
        ),
        key = JSON.stringify(labels);
      const entry = grouped.get(key) ?? { labels, rows: [] };
      entry.rows.push(row);
      grouped.set(key, entry);
    }
    return [...grouped.values()].map(({ labels, rows }) => {
      const values = rows
          .map((row) => (spec.aggregate.column ? row[spec.aggregate.column] : 1))
          .filter((value) => value != null),
        numbers = values.filter((value): value is number => typeof value === 'number');
      let value = 0;
      switch (spec.aggregate.function) {
        case 'count':
          value = values.length;
          break;
        case 'sum':
          value = numbers.reduce((sum, x) => sum + x, 0);
          break;
        case 'avg':
          value = numbers.length ? numbers.reduce((sum, x) => sum + x, 0) / numbers.length : 0;
          break;
        case 'min':
          value = numbers.length ? Math.min(...numbers) : 0;
          break;
        case 'max':
          value = numbers.length ? Math.max(...numbers) : 0;
      }
      return {
        labels,
        value,
        breached: !!compareThreshold(
          value,
          body.thresholdConfig.operator,
          body.thresholdConfig.value,
        ),
      };
    });
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
    async previewAlert(body, signal) {
      await ready(signal);
      body = await normalize(body, undefined, true);
      if (body.queryType === 'promql') fail('SQL preview only');
      const groups = body.builderConfig
        ? previewBuilder(body.builderConfig as SqlBuilderV1, body)
        : [
            {
              labels: {},
              value: 8,
              breached: !!compareThreshold(
                8,
                body.thresholdConfig.operator,
                body.thresholdConfig.value,
              ),
            },
          ];
      const breachedGroups = groups.filter((group) => group.breached).length;
      signal?.throwIfAborted();
      return {
        queryType: body.queryType as 'builder' | 'code',
        compiledQuery: body.query,
        builderConfig: body.builderConfig,
        datasets: body.datasets,
        measure: 'alert_value',
        dimensions: (body.builderConfig as SqlBuilderV1 | undefined)?.groupBy ?? [],
        window: {
          start: new Date(
            now - (alertDuration(body.evalConfig.rollingWindow.evalStart) ?? 600) * 1000,
          ).toISOString(),
          end: new Date(now).toISOString(),
        },
        threshold: body.thresholdConfig,
        simple: !(body.builderConfig as SqlBuilderV1 | undefined)?.groupBy?.length,
        noData: groups.length === 0,
        wouldTrigger: breachedGroups > 0,
        groups: groups.sort((a, b) => Number(b.breached) - Number(a.breached)).slice(0, 200),
        totalGroups: groups.length,
        breachedGroups,
        truncated: groups.length > 200,
      };
    },
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
          queryType: item.queryType,
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
      body = await normalize(body);
      validate(body);
      const value: Alert = {
        ...clone(body),
        ...(body.builderConfig
          ? {
              builderStatus: 'editable' as const,
              executionMode: 'owner' as const,
              executionOwner: 'Demo user',
            }
          : body.queryType !== 'promql'
            ? { executionMode: 'server' as const }
            : { executionMode: 'owner' as const, executionOwner: 'Demo user' }),
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
      body = await normalize(body, previous);
      validate(body);
      const value: Alert = {
        ...clone(body),
        ...(body.builderConfig ? { builderStatus: 'editable' as const } : {}),
        ...(body.queryType !== 'promql'
          ? {
              executionMode:
                body.builderConfig || previous.executionMode === 'owner'
                  ? ('owner' as const)
                  : ('server' as const),
            }
          : {}),
        ...(body.queryType === 'promql' || body.builderConfig || previous.executionMode === 'owner'
          ? { executionMode: 'owner' as const, executionOwner: 'Demo user' }
          : {}),
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
        value.sqlRuntime = { health: 'ok', error: null, lastEvaluatedAt: new Date().toISOString() };
        value.state =
          value.builderConfig && sqlBuilderConfig(value.builderConfig)
            ? previewBuilder(value.builderConfig, value).some((group) => group.breached)
              ? 'triggered'
              : 'not-triggered'
            : compareThreshold(8, value.thresholdConfig.operator, value.thresholdConfig.value)
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
