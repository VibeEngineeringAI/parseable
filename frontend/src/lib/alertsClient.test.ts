import { afterEach, describe, expect, it, vi } from 'vitest';
import { createClient } from './client';
import {
  alertFixture,
  alertRequest,
  alertSummaryFixture,
  targetFixture,
} from './__fixtures__/alerts';
import type { ParseableClient } from './types';

type Case = {
  name: string;
  run: (client: ParseableClient, signal: AbortSignal) => Promise<unknown>;
  url: string;
  method?: string;
  body?: unknown;
  reply?: unknown;
  text?: string;
  read?: boolean;
};
const id = 'id/with space',
  alertUrl = '/api/v1/alerts/id%2Fwith%20space',
  targetUrl = '/api/v1/targets/id%2Fwith%20space';
const targetBody = {
  name: 'hook',
  type: 'webhook' as const,
  endpoint: 'https://example.com/secret',
  headers: { 'X-Key': 'secret' },
  skipTlsCheck: false,
};
const cases: Case[] = [
  {
    name: 'list',
    run: (c, s) => c.listAlerts(s),
    url: '/api/v1/alerts?limit=1000&offset=0',
    reply: [{ ...alertSummaryFixture, severity: 'High' }],
    read: true,
  },
  {
    name: 'detail',
    run: (c, s) => c.getAlert(id, s),
    url: alertUrl,
    reply: alertFixture,
    read: true,
  },
  {
    name: 'create',
    run: (c) => c.createAlert(alertRequest),
    url: '/api/v1/alerts',
    method: 'POST',
    body: alertRequest,
    reply: alertFixture,
  },
  {
    name: 'update with hold config',
    run: (c) => c.updateAlert(id, alertRequest),
    url: alertUrl,
    method: 'PUT',
    body: alertRequest,
    reply: alertFixture,
  },
  {
    name: 'delete',
    run: (c) => c.deleteAlert(id),
    url: alertUrl,
    method: 'DELETE',
    text: 'Deleted alert with ID- id',
  },
  {
    name: 'enable',
    run: (c) => c.enableAlert(id),
    url: `${alertUrl}/enable`,
    method: 'PATCH',
    reply: alertFixture,
  },
  {
    name: 'disable',
    run: (c) => c.disableAlert(id),
    url: `${alertUrl}/disable`,
    method: 'PATCH',
    reply: { ...alertFixture, state: 'disabled' },
  },
  {
    name: 'mute',
    run: (c) => c.muteAlert(id, 'indefinite'),
    url: `${alertUrl}/update_notification_state`,
    method: 'PATCH',
    body: { state: 'indefinite' },
    reply: { ...alertFixture, notificationState: { mute: 'indefinite' } },
  },
  {
    name: 'evaluate without body',
    run: (c) => c.evaluateAlert(id),
    url: `${alertUrl}/evaluate_alert`,
    method: 'PUT',
    reply: alertFixture,
  },
  {
    name: 'tags',
    run: (c, s) => c.listAlertTags(s),
    url: '/api/v1/alerts/list_tags',
    reply: ['production'],
    read: true,
  },
  {
    name: 'targets',
    run: (c, s) => c.listAlertTargets(s),
    url: '/api/v1/targets',
    reply: [{ target: targetFixture, enabled: true }],
    read: true,
  },
  {
    name: 'target detail',
    run: (c, s) => c.getAlertTarget(id, s),
    url: targetUrl,
    reply: { target: targetFixture, enabled: false, error: 'Blocked by policy' },
    read: true,
  },
  {
    name: 'target create',
    run: (c) => c.createAlertTarget(targetBody),
    url: '/api/v1/targets',
    method: 'POST',
    body: targetBody,
    reply: targetFixture,
  },
  {
    name: 'target update',
    run: (c) => c.updateAlertTarget(id, targetBody),
    url: targetUrl,
    method: 'PUT',
    body: targetBody,
    reply: targetFixture,
  },
  {
    name: 'target delete',
    run: (c) => c.deleteAlertTarget(id),
    url: targetUrl,
    method: 'DELETE',
    reply: targetFixture,
  },
];
afterEach(() => vi.unstubAllGlobals());
describe('alerts client requests', () => {
  it.each(cases)('$name uses the exact contract and read signal', async (entry) => {
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response(entry.text ?? JSON.stringify(entry.reply)));
    vi.stubGlobal('fetch', fetch);
    const signal = new AbortController().signal;
    const result = await entry.run(createClient({ mode: 'live' }), signal);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe(entry.url);
    expect(init.credentials).toBe('include');
    expect(init.method ?? 'GET').toBe(entry.method ?? 'GET');
    expect(init.signal).toBe(entry.read ? signal : undefined);
    if (entry.body) {
      expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
      expect(JSON.parse(init.body)).toEqual(entry.body);
    } else expect(init.body).toBeUndefined();
    if (entry.name === 'list') expect(result).toEqual([alertSummaryFixture]);
  });
  it.each(cases)('$name preserves plain-text auth errors', async (entry) => {
    for (const status of [401, 403]) {
      const onUnauthorized = vi.fn();
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('Access denied', { status })));
      await expect(
        entry.run(createClient({ mode: 'live', onUnauthorized }), new AbortController().signal),
      ).rejects.toMatchObject({ status, message: 'Access denied' });
      expect(onUnauthorized).toHaveBeenCalledTimes(status === 401 ? 1 : 0);
    }
  });
  it.each(cases)(
    '$name maps Rust dataset-permission 401s without session recovery',
    async (entry) => {
      // src/alerts/mod.rs and src/utils/mod.rs; AlertError::Error prefixes actix errors.
      for (const message of [
        'User does not have access to stream- private_metrics',
        'ActixError: User does not have access to stream- private_logs',
        'User does not have access to PromQL alert stream',
        'ActixError: User does not have access to PromQL alert stream',
      ]) {
        const onUnauthorized = vi.fn();
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(message, { status: 401 })));
        await expect(
          entry.run(createClient({ mode: 'live', onUnauthorized }), new AbortController().signal),
        ).rejects.toMatchObject({
          status: 403,
          message: `Permission denied: ${message.replace(/^ActixError: /, '')}`,
          detail: message,
        });
        expect(onUnauthorized).not.toHaveBeenCalled();
      }
    },
  );
  it.each(cases)('$name recovers the real Rust expired/missing-session 401s', async (entry) => {
    for (const message of [
      'Your session has expired or is no longer valid. Please re-authenticate to access this resource.',
      'ActixError: No authentication method supplied',
      'No authentication method supplied',
    ]) {
      const onUnauthorized = vi.fn();
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(message, { status: 401 })));
      await expect(
        entry.run(createClient({ mode: 'live', onUnauthorized }), new AbortController().signal),
      ).rejects.toMatchObject({ status: 401, message });
      expect(onUnauthorized).toHaveBeenCalledOnce();
    }
  });
  it('maps the SQL authorization helper missing-stream 401 without expiring the session', async () => {
    const onUnauthorized = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(new Response('ActixError: Stream not found: missing', { status: 401 })),
    );
    await expect(
      createClient({ mode: 'live', onUnauthorized }).updateAlert(id, alertRequest),
    ).rejects.toMatchObject({ status: 404, message: 'Stream not found: missing' });
    expect(onUnauthorized).not.toHaveBeenCalled();
  });
  it.each(cases.filter((entry) => !entry.text))(
    '$name rejects malformed success payloads',
    async (entry) => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}')));
      await expect(
        entry.run(createClient({ mode: 'live' }), new AbortController().signal),
      ).rejects.toMatchObject({ status: 502, message: `Unexpected response from ${entry.url}` });
    },
  );
  it('retrieves every page and normalizes summary severity', async () => {
    const first = Array.from({ length: 1000 }, (_, index) => ({
      ...alertSummaryFixture,
      id: String(index),
      severity: 'High',
    }));
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(first)))
      .mockResolvedValueOnce(new Response(JSON.stringify([alertSummaryFixture])));
    vi.stubGlobal('fetch', fetch);
    const result = await createClient({ mode: 'live' }).listAlerts();
    expect(result).toHaveLength(1001);
    expect(result[0].severity).toBe('high');
    expect(fetch.mock.calls[1][0]).toBe('/api/v1/alerts?limit=1000&offset=1000');
  });
  it.each(['alert', 'target'])('preserves HTTP 400 for a missing %s', async (kind) => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('Missing resource', { status: 400 })),
    );
    const client = createClient({ mode: 'live' });
    await expect(
      kind === 'alert' ? client.getAlert(id) : client.getAlertTarget(id),
    ).rejects.toMatchObject({ status: 400, message: 'Missing resource' });
  });
  it('preserves target-in-use conflicts and JSON policy errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response("Can't delete a Target which is being used", { status: 409 }),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ message: 'Target domain is denied', hint: 'Ask admin' }), {
            status: 400,
          }),
        ),
    );
    const client = createClient({ mode: 'live' });
    await expect(client.deleteAlertTarget(id)).rejects.toMatchObject({ status: 409 });
    await expect(client.createAlertTarget(targetBody)).rejects.toMatchObject({
      status: 400,
      message: 'Target domain is denied',
      detail: { hint: 'Ask admin' },
    });
  });
  it.each([
    [{}, false],
    [{ license: { plan: 'Enterprise' } }, false],
    [{ capabilities: { promqlAlerts: false } }, false],
    [{ capabilities: { promqlAlerts: true } }, true],
  ])('requires an explicit PromQL alerts boolean %j', async (reply, enabled) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(reply))));
    expect((await createClient({ mode: 'live' }).about()).capabilities.promqlAlerts).toBe(enabled);
  });
  it('rejects a non-boolean explicit capability', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('{"capabilities":{"promqlAlerts":"true"}}')),
    );
    await expect(createClient({ mode: 'live' }).about()).rejects.toMatchObject({ status: 502 });
  });
});
