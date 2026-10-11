import { describe, expect, it, vi } from 'vitest';
import {
  alertDraft,
  alertDuration,
  buildAlertPayload,
  compareThreshold,
  displayDate,
  filterSortAlerts,
  formatAlertDate,
  muteState,
  newAlertDraft,
  promqlSyntaxError,
  resolveAlertTypes,
  safeDeliveryError,
  utcMuteDate,
  validateAlert,
  type AlertDraft,
} from './helpers';
import {
  buildTargetPayload,
  invalidHeader,
  targetDraft,
  targetType,
  validateTarget,
} from './targetHelpers';
import type { Alert, AlertSummary, ParseableClient } from '../../lib/types';
import humantime from './__fixtures__/humantime.json';

const draft = (): AlertDraft => ({
  ...newAlertDraft(true),
  dataset: 'metrics',
  query: 'up',
  title: 'Host load',
  threshold: '2.5',
});
const original = (): Alert => ({
  ...buildAlertPayload(draft()),
  id: 'alert',
  version: 'v2',
  state: 'triggered',
  notificationState: { mute: 'indefinite' },
  created: '2026-10-09T00:00:00Z',
  lastTriggeredAt: null,
  promqlConfig: { holdDuration: '5m', custom: 'keep' },
  executionIdentity: { userId: 'old', tenantId: 'DEFAULT_TENANT' },
  promqlRuntime: {
    health: 'ok',
    error: null,
    lastEvaluatedAt: null,
    instances: {},
    deliveries: [],
  },
  units: 'bytes',
});
describe('alert forms and payloads', () => {
  it('resends PromQL config while excluding runtime and managed response fields', () => {
    const alert = original(),
      form = alertDraft(alert);
    form.title = 'Edited';
    form.hold = '1h30m';
    const payload = buildAlertPayload(form, alert);
    expect(payload.promqlConfig).toEqual({ holdDuration: '1h30m', custom: 'keep' });
    expect(payload.units).toBe('bytes');
    for (const key of [
      'id',
      'version',
      'state',
      'notificationState',
      'created',
      'lastTriggeredAt',
      'promqlRuntime',
      'executionIdentity',
    ])
      expect(payload).not.toHaveProperty(key);
    expect(payload.notificationConfig).toEqual({ interval: 1 });
    expect(payload.evalConfig.rollingWindow).toEqual({
      evalStart: '10m',
      evalEnd: 'now',
      evalFrequency: 1,
    });
  });
  it('defaults and round-trips hold duration, preserves targets and tags', () => {
    const form = draft();
    form.tags = ['prod', 'metrics'].map((value) => ({ id: value, value }));
    form.targets = ['one', 'two'];
    const payload = buildAlertPayload(form);
    expect(payload.promqlConfig).toEqual({ holdDuration: '0s' });
    expect(payload.tags).toEqual(['prod', 'metrics']);
    expect(alertDraft(payload).targets).toEqual(form.targets);
    payload.targets.push('three');
    expect(form.targets).toEqual(['one', 'two']);
  });
  it.each(['edit', 'duplicate'])(
    'preserves nonblank tag bytes and omits blank tags through %s',
    (mode) => {
      const source = {
        ...original(),
        tags: ['team,west', ' padded ', '', 'team,west', 'with\tspace', '  \t '],
      };
      const form = alertDraft(source);
      if (mode === 'edit') form.threshold = '3';
      else form.title = `${source.title} (Copy)`;
      const payload = buildAlertPayload(form, source);
      expect(payload.tags).toEqual(['team,west', ' padded ', 'team,west', 'with\tspace']);
      expect(new Set(form.tags.map(({ id }) => id)).size).toBe(form.tags.length);
      form.tags[0].value = 'changed';
      expect(source.tags[0]).toBe('team,west');
      expect(payload.tags![0]).toBe('team,west');
    },
  );
  it('builds code SQL without PromQL config and accepts state-tracking-only SQL', () => {
    const form = {
      ...draft(),
      type: 'code' as const,
      query: 'SELECT COUNT(*) FROM "logs"',
      dataset: 'logs',
    };
    expect(validateAlert(form, false)).toEqual({});
    expect(buildAlertPayload(form)).toMatchObject({ queryType: 'code', targets: [] });
    expect(buildAlertPayload(form)).not.toHaveProperty('promqlConfig');
  });
  it('accepts the dashboard URL handoff', () => {
    expect(
      newAlertDraft(
        true,
        new URLSearchParams({
          dataset: 'otel metrics',
          queryBuilderType: 'promql',
          alertQuery: 'sum(up)',
          title: 'Availability',
        }),
      ),
    ).toMatchObject({
      type: 'promql',
      dataset: 'otel metrics',
      query: 'sum(up)',
      title: 'Availability',
    });
  });
  it.each(['sql', 'code', 'builder', 'ai'])(
    'honours the %s dashboard handoff even with PromQL enabled',
    (type) => {
      expect(
        newAlertDraft(
          true,
          new URLSearchParams({
            queryBuilderType: type,
            dataset: 'logs',
            alertQuery: 'SELECT COUNT(*) FROM "logs"',
          }),
        ),
      ).toMatchObject({ type: 'code', dataset: 'logs', query: 'SELECT COUNT(*) FROM "logs"' });
    },
  );
  it.each(['10mins', '2hrs', '30secs', '0', '5millis'])(
    'saves existing duration %s unchanged in both fields',
    (duration) => {
      const source = original();
      source.evalConfig.rollingWindow.evalStart = duration;
      source.promqlConfig = { holdDuration: duration };
      const form = alertDraft(source);
      form.threshold = '4';
      expect(validateAlert(form, true)).toEqual({});
      expect(buildAlertPayload(form, source)).toMatchObject({
        evalConfig: { rollingWindow: { evalStart: duration } },
        promqlConfig: { holdDuration: duration },
      });
    },
  );
  it.each([
    ['title', ' ', 'title'],
    ['dataset', '', 'dataset'],
    ['query', '', 'query'],
    ['query', 'up{', 'query'],
    ['query', 'up[5m]', 'query'],
    ['threshold', '', 'threshold'],
    ['threshold', 'Infinity', 'threshold'],
    ['threshold', 'NaN', 'threshold'],
    ['frequency', '0', 'frequency'],
    ['frequency', '1.5', 'frequency'],
    ['frequency', '1441', 'frequency'],
    ['hold', '31d', 'hold'],
    ['hold', '5 elephants', 'hold'],
    ['window', 'now-10m', 'window'],
  ])('rejects %s=%s', (field, value, error) => {
    expect(validateAlert({ ...draft(), [field]: value }, true)).toHaveProperty(error);
  });
  it('uses explicit capability and the 20-target limit', () => {
    expect(validateAlert(draft(), false)).toHaveProperty('type');
    expect(
      validateAlert({ ...draft(), targets: Array.from({ length: 21 }, (_, i) => String(i)) }, true),
    ).toHaveProperty('targets');
    expect(validateAlert({ ...draft(), hold: '30d', frequency: '1440' }, true)).toEqual({});
  });
  it('rejects selector history beyond 31 days', () => {
    expect(promqlSyntaxError('rate(up[32d])')).toContain('31 days');
    expect(promqlSyntaxError('rate(up[31d])')).toBeUndefined();
  });
  it.each(['up', 'sum(up)', 'vector(1)', 'up + 1', '(up)', 'rate(up[5m])'])(
    'accepts instant vector %s',
    (query) => expect(promqlSyntaxError(query)).toBeUndefined(),
  );
  it.each(['1', '1 + 2', '(1)', 'scalar(up)', 'time()', 'up[5m]', 'up[5m:1m]'])(
    'rejects non-vector %s',
    (query) => expect(promqlSyntaxError(query)).toContain('instant vector'),
  );
});
describe('durations, thresholds and mute states', () => {
  it.each(humantime.cases)('matches Rust humantime for "$input"', ({ input, seconds }) => {
    expect(alertDuration(input)).toBe(seconds ?? undefined);
  });
  it.each([
    ['0s', 0],
    ['1h30m', 5400],
    ['10 minutes', 600],
    ['1 day 2 hours', 93600],
    ['2w', 1209600],
    ['0.5s', 0.5],
    ['500ms', 0.5],
  ])('parses %s', (value, expected) => expect(alertDuration(value as string)).toBe(expected));
  it.each(['', '-1m', '1m garbage', '5', 'Infinitys', '1e3s'])(
    'rejects invalid duration %s',
    (value) => expect(alertDuration(value)).toBeUndefined(),
  );
  it.each([
    ['>', 3, 2, true],
    ['>', 2, 2, false],
    ['>=', 2, 2, true],
    ['<', 1, 2, true],
    ['<=', 2, 2, true],
    ['=', 2, 2, true],
    ['!=', 2, 2, false],
  ])('compares %s', (operator, value, threshold, expected) =>
    expect(
      compareThreshold(value as number, operator as AlertDraft['operator'], threshold as number),
    ).toBe(expected),
  );
  it('rejects non-finite preview values', () =>
    expect(compareThreshold(NaN, '>', 1)).toBeUndefined());
  it.each(['notify', { mute: '2026-10-08T00:00:00Z' }])(
    'recognizes unmuted or expired mute',
    (state) => expect(muteState(state, Date.parse('2026-10-09T00:00:00Z')).muted).toBe(false),
  );
  it.each(['+262142-12-31T23:59:59.999999999+00:00', { mute: 'indefinite' }, 'indefinite'])(
    'recognizes indefinite mute',
    (state) => expect(muteState(state).label).toBe('Muted indefinitely'),
  );
  it('recognizes summary and detail timestamp mutes', () => {
    const date = '2026-10-10T00:00:00Z',
      now = Date.parse('2026-10-09T00:00:00Z');
    expect(muteState(date, now)).toEqual(muteState({ mute: date }, now));
    expect(muteState(date, now).muted).toBe(true);
  });
  it('uses UTC for custom mute and requires a future time', () => {
    const now = Date.parse('2026-10-09T00:00:00Z');
    expect(utcMuteDate('2026-10-10T12:00', now)).toEqual({ state: '2026-10-10T12:00:00.000Z' });
    expect(utcMuteDate('2026-10-08T12:00', now).error).toContain('future');
    expect(utcMuteDate('', now).error).toBeDefined();
    expect(utcMuteDate('2099-02-31T12:00', now).error).toContain('valid');
  });
  it('normalizes chrono summary timestamps and redacts delivery URLs', () => {
    expect(displayDate('2026-10-09 12:00:00.123456789 UTC')).toBe('2026-10-09T12:00:00.123Z');
    expect(displayDate('bad')).toBeUndefined();
    expect(safeDeliveryError('failed (https://hooks.slack.com/token-secret)')).toBe(
      'failed ([redacted endpoint])',
    );
  });
  it('formats runtime and mute timestamps as 24-hour UTC, including offset input', () => {
    expect(formatAlertDate('2026-10-09T12:07:22-05:00')).toBe('2026-10-09 17:07:22 UTC');
    expect(formatAlertDate('2026-10-09 17:07:22.123456789 UTC')).toBe('2026-10-09 17:07:22 UTC');
    expect(muteState('2026-10-10T17:07:22Z', Date.parse('2026-10-09T00:00:00Z')).label).toBe(
      'Muted until 2026-10-10 17:07:22 UTC',
    );
  });
});
describe('list filtering, sorting and bounded type discovery', () => {
  const rows: AlertSummary[] = [
    {
      ...original(),
      id: 'a',
      title: 'Zulu',
      severity: 'critical',
      datasets: ['b'],
      queryType: 'promql',
      tags: ['prod'],
    },
    {
      ...original(),
      id: 'b',
      title: 'Alpha',
      severity: 'low',
      datasets: ['a'],
      queryType: 'builder',
      tags: ['dev'],
      state: 'disabled',
    },
    {
      ...original(),
      id: 'c',
      title: 'Bravo',
      severity: 'high',
      datasets: ['c'],
      queryType: 'code',
      tags: ['prod'],
      state: 'not-triggered',
    },
  ];
  it('filters title case-insensitively and tags exactly', () => {
    expect(filterSortAlerts(rows, 'BRAVO', 'prod', 'title', false).map((row) => row.id)).toEqual([
      'c',
    ]);
    expect(filterSortAlerts(rows, '', 'pro', 'title', false)).toEqual([]);
    expect(rows[0].title).toBe('Zulu');
  });
  it.each([
    ['title', ['b', 'c', 'a']],
    ['severity', ['a', 'c', 'b']],
    ['state', ['b', 'c', 'a']],
    ['type', ['b', 'a', 'c']],
    ['dataset', ['b', 'a', 'c']],
    ['tags', ['b', 'a', 'c']],
  ])('sorts %s and reverses direction', (sort, ids) => {
    const ascending = filterSortAlerts(rows, '', '', sort as 'title', false).map((row) => row.id);
    expect(ascending).toEqual(ids);
    expect(filterSortAlerts(rows, '', '', sort as 'title', true).map((row) => row.id)).toEqual(
      [...ids].reverse(),
    );
  });
  it('tolerates individual errors, uses at most six workers and passes the signal', async () => {
    let active = 0,
      max = 0;
    const getAlert = vi.fn(async (id, signal) => {
      signal.throwIfAborted();
      active++;
      max = Math.max(max, active);
      await Promise.resolve();
      active--;
      if (id === 'bad') throw new Error('missing');
      return { queryType: 'code' };
    });
    const signal = new AbortController().signal;
    const input = Array.from({ length: 20 }, (_, index) => ({
      ...rows[0],
      id: index ? String(index) : 'bad',
      queryType: undefined,
    }));
    const result = await resolveAlertTypes(
      { getAlert } as unknown as ParseableClient,
      input,
      signal,
    );
    expect(max).toBeLessThanOrEqual(6);
    expect(max).toBeGreaterThan(1);
    expect(result.rows).toHaveLength(20);
    expect(result.unchecked).toHaveLength(1);
    expect(getAlert.mock.calls.every(([, value]) => value === signal)).toBe(true);
    expect(input.every((row) => row.queryType === undefined)).toBe(true);
  });
  it('caches resolved types per client and retries failures on reload', async () => {
    let fail = true;
    const getAlert = vi.fn(async (id: string) => {
      if (id === 'bad' && fail) throw new Error('missing');
      return { queryType: 'code' };
    });
    const client = { getAlert } as unknown as ParseableClient,
      signal = new AbortController().signal;
    const input = [
      { ...rows[0], id: 'new', queryType: undefined },
      { ...rows[0], id: 'bad', queryType: undefined },
      { ...rows[0], id: 'known', queryType: 'builder' as const },
    ];
    expect((await resolveAlertTypes(client, input, signal)).unchecked).toEqual([rows[0].title]);
    expect(getAlert.mock.calls.map(([id]) => id).sort()).toEqual(['bad', 'new']);
    getAlert.mockClear();
    fail = false;
    const reloaded = await resolveAlertTypes(
      client,
      input.map((row) => ({ ...row, queryType: undefined })),
      signal,
    );
    expect(getAlert.mock.calls.map(([id]) => id)).toEqual(['bad']);
    expect(reloaded.unchecked).toEqual([]);
    expect(reloaded.rows.map((row) => row.queryType)).toEqual(['code', 'code', 'builder']);
    getAlert.mockClear();
    await resolveAlertTypes(client, input, signal);
    expect(getAlert).not.toHaveBeenCalled();
  });
  it('skips summaries that carry a query type and non-threshold alerts', async () => {
    const getAlert = vi.fn();
    const result = await resolveAlertTypes(
      { getAlert } as unknown as ParseableClient,
      [rows[0], { ...rows[1], id: 'anomaly', alertType: 'anomaly', queryType: undefined }],
      new AbortController().signal,
    );
    expect(getAlert).not.toHaveBeenCalled();
    expect(result.unchecked).toEqual([]);
    expect(result.rows.map((row) => row.queryType)).toEqual(['promql', undefined]);
  });
});
describe('target forms', () => {
  it('recognizes masked Alertmanager, requires re-entry and builds top-level credentials', () => {
    const target = {
      id: 'am',
      name: 'AM',
      type: 'webhook' as const,
      endpoint: 'https://********',
      username: 'svc',
      password: '********',
    };
    expect(targetType(target)).toBe('alertManager');
    const form = targetDraft(target);
    expect(form.endpoint).toBe('');
    expect(form.password).toBe('');
    expect(validateTarget(form)).toHaveProperty('endpoint');
    form.endpoint = 'https://example.com/api/v2/alerts';
    form.password = 'secret';
    expect(buildTargetPayload(form)).toMatchObject({
      type: 'alertManager',
      username: 'svc',
      password: 'secret',
    });
    expect(buildTargetPayload(form)).not.toHaveProperty('auth');
  });
  it('omits TLS and auth fields for Slack', () => {
    const form = {
      ...targetDraft(),
      type: 'slack' as const,
      name: 'Slack',
      endpoint: 'https://hooks.slack.com/services/test',
    };
    expect(validateTarget(form)).toEqual({});
    expect(buildTargetPayload(form)).toEqual({
      name: 'Slack',
      type: 'slack',
      endpoint: form.endpoint,
    });
    expect(validateTarget({ ...form, endpoint: 'http://example.com' })).toHaveProperty('endpoint');
  });
  it('rejects masked endpoints, denied, duplicate and incomplete headers', () => {
    const form = { ...targetDraft(), name: 'hook', endpoint: 'https://example.com' };
    expect(validateTarget({ ...form, endpoint: 'https://********' })).toHaveProperty('endpoint');
    for (const headers of [
      [{ id: 'a', key: 'Cookie', value: 'a' }],
      [{ id: 'a', key: 'X-Key', value: '' }],
      [
        { id: 'a', key: 'X-Key', value: 'a' },
        { id: 'b', key: 'x-key', value: 'b' },
      ],
    ])
      expect(validateTarget({ ...form, headers })).toHaveProperty('headers');
  });
  it('reports the first invalid header row and the fields to fix', () => {
    const valid = { id: 'a', key: 'X-One', value: 'one' };
    const blank = { id: 'b', key: '', value: '' };
    expect(invalidHeader([valid, blank])).toBeUndefined();
    expect(invalidHeader([valid, { id: 'c', key: 'X-Two', value: '' }])).toMatchObject({
      index: 1,
      fields: ['value'],
    });
    expect(invalidHeader([valid, blank, { id: 'c', key: '', value: 'two' }])).toMatchObject({
      index: 2,
      fields: ['key'],
    });
    expect(invalidHeader([{ id: 'c', key: 'X Two', value: 'a\nb' }])).toMatchObject({
      index: 0,
      fields: ['key', 'value'],
    });
    expect(invalidHeader([valid, { id: 'c', key: 'Cookie', value: 'a' }])).toEqual({
      index: 1,
      fields: ['key'],
      message: 'The Cookie header is blocked by outbound policy.',
    });
    expect(invalidHeader([valid, { id: 'c', key: ' x-one ', value: 'b' }])).toEqual({
      index: 1,
      fields: ['key'],
      message: 'Header names must be unique.',
    });
    // The message belongs to the row that is reported, not to a later invalid row.
    const headers = [
      valid,
      { id: 'c', key: 'X-Two', value: '' },
      { id: 'd', key: 'Host', value: 'h' },
    ];
    expect(validateTarget({ ...targetDraft(), headers }).headers).toBe(
      invalidHeader(headers)?.message,
    );
    expect(invalidHeader(headers)?.index).toBe(1);
  });
});
