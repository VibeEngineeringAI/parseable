import { describe, expect, it } from 'vitest';
import { createNativeKeystonePageTransport } from '../../lib/keystone/nativeTransport';
import { serverCapabilityBodies, serverCapabilityTransport } from './fixtures/serverCapabilities';
import type { KeystonePageCapabilities } from './pageContract';
import { pageGate, requestMessage, storageMessage } from './readiness';

async function decoded(server: 'default' | 'degraded' | 'ingest', calls: string[] = []) {
  const result = await serverCapabilityTransport(server, calls).capabilities();
  if (!result.ok) throw new Error(`capabilities failed: ${result.kind}`);
  return result.value;
}

describe('server-shaped capabilities', () => {
  it('explains storage on a default server instead of reporting a role problem', async () => {
    const calls: string[] = [];
    const value = await decoded('default', calls);
    expect(value.workspace.actions.read).toBe(false);
    expect(value.storage).toEqual({ state: 'unavailable', reason: 'repository_unconfigured' });
    expect(pageGate(value)).toBe('readiness');
    expect(storageMessage(value.storage.state)).toContain('not enabled');
    // Only the two capability reads; nothing lists or opens investigations.
    expect(calls.map((url) => url.replace(/^.*\/keystone\/native/, ''))).toEqual([
      '/capabilities',
      '/ui/capabilities',
    ]);
  });

  it('reports degraded storage before the read action it disables', async () => {
    const value = await decoded('degraded');
    expect(value.storage).toEqual({ state: 'degraded', reason: 'repository_degraded' });
    expect(value.workspace.actions.read).toBe(false);
    expect(pageGate(value)).toBe('readiness');
    expect(storageMessage(value.storage.state)).toContain('restart');
  });

  it('treats a node that does not serve investigations as having no storage', async () => {
    const value = await decoded('ingest');
    expect(value.storage).toEqual({ state: 'unavailable', reason: 'mode_disabled' });
    expect(pageGate(value)).toBe('readiness');
  });

  it('keeps a disabled mode unavailable even when its repository reports ready', async () => {
    const bodies = serverCapabilityBodies('ingest');
    bodies.page.storage = 'ready';
    const fetcher = async (input: RequestInfo | URL) =>
      new Response(
        JSON.stringify(String(input).endsWith('/ui/capabilities') ? bodies.ui : bodies.page),
        { headers: { 'Content-Type': 'application/json' } },
      );
    const result = await createNativeKeystonePageTransport(fetcher as typeof fetch).capabilities();
    expect(result.ok && result.value.storage).toEqual({
      state: 'unavailable',
      reason: 'mode_disabled',
    });
  });

  it('reports ready storage without a reason', async () => {
    const bodies = serverCapabilityBodies('default');
    bodies.page.storage = 'ready';
    const fetcher = async (input: RequestInfo | URL) =>
      new Response(
        JSON.stringify(String(input).endsWith('/ui/capabilities') ? bodies.ui : bodies.page),
        { headers: { 'Content-Type': 'application/json' } },
      );
    const result = await createNativeKeystonePageTransport(fetcher as typeof fetch).capabilities();
    expect(result.ok && result.value.storage).toEqual({ state: 'ready', reason: null });
  });

  it.each(['unauthorized', 'forbidden'] as const)(
    'reports a plain-text %s middleware answer as denied after one read',
    async (server) => {
      const calls: string[] = [];
      const result = await serverCapabilityTransport(server, calls).capabilities();
      expect(result).toMatchObject({ ok: false, kind: 'denied' });
      if (result.ok) return;
      expect(requestMessage(result)).toContain('You do not have permission');
      // The denial stops before the workspace capability read.
      expect(calls.map((url) => url.replace(/^.*\/keystone\/native/, ''))).toEqual([
        '/capabilities',
      ]);
    },
  );

  it('rejects a server without Keystone rather than guessing', async () => {
    const result = await serverCapabilityTransport('legacy').capabilities();
    expect(result.ok).toBe(false);
  });

  it('reports a role decision only once storage is ready', () => {
    const ready: KeystonePageCapabilities = {
      storage: { state: 'ready', reason: null },
      execution: { state: 'ready', reason: null },
      workspace: {
        schemaVersion: 1,
        generative: { state: 'ready', reason: null },
        tools: { state: 'ready', reason: null },
        actions: {
          read: false,
          run: false,
          branch: false,
          editLayout: false,
          manageProviders: false,
        },
      },
    };
    expect(pageGate(ready)).toBe('denied');
    ready.workspace.actions.read = true;
    expect(pageGate(ready)).toBe('open');
  });
});
