import { describe, expect, it } from 'vitest';
import { createDemoClient } from './demo';
import { alert, alertSummary, alertTarget, alertTargetStatus } from './alertsContract';
import { alertDraft, buildAlertPayload } from '../features/alerts/helpers';
import { targetDraft, targetType } from '../features/alerts/targetHelpers';
import { alertRequest } from './__fixtures__/alerts';

describe('demo alerts', () => {
  it('has realistic, valid fixtures with two instances and a failed delivery', async () => {
    const client = createDemoClient(),
      summaries = await client.listAlerts();
    expect(summaries).toHaveLength(4);
    expect(summaries.every(alertSummary)).toBe(true);
    const details = await Promise.all(summaries.map((row) => client.getAlert(row.id)));
    expect(details.every(alert)).toBe(true);
    expect(details.map((row) => row.queryType)).toContain('builder');
    expect(summaries.map((row) => row.queryType)).toEqual(details.map((row) => row.queryType));
    expect(Object.keys(details[0].promqlRuntime!.instances)).toHaveLength(2);
    expect(details[0].promqlRuntime!.deliveries[0].attempts).toBe(2);
    expect((await client.listAlertTargets()).every(alertTargetStatus)).toBe(true);
  });
  it('creates, edits, evaluates, mutes, enables and deletes while preserving config', async () => {
    const client = createDemoClient();
    const created = await client.createAlert({ ...alertRequest, datasets: ['demo_metrics'] });
    const form = alertDraft(created);
    form.hold = '1h';
    const edited = await client.updateAlert(created.id, buildAlertPayload(form, created));
    expect(edited.promqlConfig).toEqual({ holdDuration: '1h' });
    expect((await client.evaluateAlert(created.id)).promqlRuntime!.health).toBe('noData');
    expect((await client.muteAlert(created.id, 'indefinite')).notificationState).toEqual({
      mute: 'indefinite',
    });
    expect((await client.muteAlert(created.id, '1h')).notificationState).toHaveProperty('mute');
    expect((await client.muteAlert(created.id, 'notify')).notificationState).toBe('notify');
    expect((await client.disableAlert(created.id)).state).toBe('disabled');
    expect((await client.enableAlert(created.id)).state).toBe('not-triggered');
    await client.deleteAlert(created.id);
    await expect(client.getAlert(created.id)).rejects.toMatchObject({ status: 400 });
  });
  it('keeps state per client and returns clones', async () => {
    const client = createDemoClient(),
      other = createDemoClient();
    const rows = await client.listAlerts();
    rows[0].title = 'mutated';
    rows[0].datasets.push('mutated');
    expect((await client.listAlerts())[0].title).toBe('High host load');
    const detail = await client.getAlert(rows[0].id);
    detail.promqlRuntime!.instances['fake'] = {
      labels: {},
      state: 'resolved',
      value: 0,
      lastSeen: 'now',
      pendingSince: null,
    };
    expect((await client.getAlert(rows[0].id)).promqlRuntime!.instances).not.toHaveProperty('fake');
    await client.deleteAlert(rows[0].id);
    expect(await other.listAlerts()).toHaveLength(4);
    const targets = await client.listAlertTargets();
    targets[0].target.name = 'mutated';
    expect((await client.listAlertTargets())[0].target.name).toBe('Operations Slack');
  });
  it('masks every target secret and recognizes the backend Alertmanager shape', async () => {
    const client = createDemoClient();
    const secrets = ['svc-user', 'secret-pass', 'secret-path', 'header-secret'];
    const leaks = (value: unknown) =>
      secrets.filter((secret) => JSON.stringify(value).includes(secret));
    const target = await client.createAlertTarget({
      name: 'AM',
      type: 'alertManager',
      endpoint: 'https://example.com/secret-path/api/v2/alerts',
      username: 'svc-user',
      password: 'secret-pass',
      skipTlsCheck: false,
    });
    expect(target).toMatchObject({
      type: 'webhook',
      endpoint: 'https://********',
      username: '********',
      password: '********',
    });
    expect(targetType(target)).toBe('alertManager');
    const fetched = (await client.getAlertTarget(target.id)).target;
    expect(fetched).toEqual(target);
    expect(alertTarget(fetched)).toBe(true);
    expect(leaks([target, fetched, await client.listAlertTargets()])).toEqual([]);
    // The edit form never carries masks forward; the demo uses the same form validation.
    const form = targetDraft(fetched);
    expect([form.username, form.password]).toEqual(['', '']);
    for (const credentials of [
      { username: '********', password: 'secret-pass' },
      { username: 'svc-user', password: '********' },
    ])
      await expect(
        client.updateAlertTarget(target.id, {
          name: 'AM',
          type: 'alertManager',
          endpoint: 'https://example.com/api/v2/alerts',
          ...credentials,
          skipTlsCheck: false,
        }),
      ).rejects.toMatchObject({ status: 400 });
    const unauthenticated = await client.updateAlertTarget(target.id, {
      name: 'AM',
      type: 'alertManager',
      endpoint: 'https://example.com/api/v2/alerts',
      skipTlsCheck: false,
    });
    expect(unauthenticated).toMatchObject({ username: null, password: null });
    expect(targetType(unauthenticated)).toBe('alertManager');
    const updated = await client.updateAlertTarget(target.id, {
      name: 'AM',
      type: 'webhook',
      endpoint: 'https://example.com/secret-path',
      headers: { 'X-Key': 'header-secret' },
      skipTlsCheck: false,
    });
    expect(updated).toMatchObject({
      endpoint: 'https://********',
      headers: { 'X-Key': '********' },
    });
    expect(updated).not.toHaveProperty('username');
    expect(targetType(updated)).toBe('webhook');
    expect(
      leaks([updated, await client.getAlertTarget(target.id), await client.listAlertTargets()]),
    ).toEqual([]);
    await client.deleteAlertTarget(target.id);
    await expect(client.getAlertTarget(target.id)).rejects.toMatchObject({ status: 400 });
  });
  it('rejects in-use deletion, immutable name changes and invalid targets', async () => {
    const client = createDemoClient(),
      target = (await client.listAlertTargets())[0].target;
    await expect(client.deleteAlertTarget(target.id)).rejects.toMatchObject({ status: 409 });
    await expect(
      client.updateAlertTarget(target.id, {
        name: 'rename',
        type: 'slack',
        endpoint: 'https://hooks.slack.com/services/test',
      }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      client.createAlert({ ...alertRequest, datasets: ['demo_metrics'], targets: ['missing'] }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      client.createAlertTarget({
        name: 'private',
        type: 'webhook',
        endpoint: 'http://127.0.0.1:9000',
        skipTlsCheck: false,
      }),
    ).rejects.toMatchObject({ status: 400 });
  });
  it('enforces limits, disabled state transitions, and aborts reads', async () => {
    const client = createDemoClient(),
      id = (await client.listAlerts())[0].id;
    await expect(
      client.createAlert({
        ...alertRequest,
        datasets: ['demo_metrics'],
        promqlConfig: { holdDuration: '31d' },
      }),
    ).rejects.toMatchObject({ status: 400 });
    await client.disableAlert(id);
    await expect(client.disableAlert(id)).rejects.toMatchObject({ status: 400 });
    await expect(client.evaluateAlert(id)).rejects.toMatchObject({ status: 400 });
    const controller = new AbortController();
    controller.abort();
    for (const read of [
      client.listAlerts(controller.signal),
      client.getAlert(id, controller.signal),
      client.listAlertTargets(controller.signal),
      client.listAlertTags(controller.signal),
    ])
      await expect(read).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('SQL preview computes numeric aggregates over the evaluation window', async () => {
    const client = createDemoClient(),
      end = new Date().toISOString(),
      start = new Date(Date.now() - 3600_000).toISOString();
    const rows = await client.query({
      sql: 'SELECT COUNT(*) AS errors FROM "application_logs" WHERE level = \'ERROR\'',
      startTime: start,
      endTime: end,
    });
    expect(rows).toEqual([{ errors: 8 }]);
    const empty = await client.query({
      sql: 'SELECT COUNT(*) FROM "application_logs" WHERE level = \'NO_SUCH_LEVEL\'',
      startTime: start,
      endTime: end,
    });
    expect(empty).toEqual([{ 'count(*)': 0 }]);
  });
});
