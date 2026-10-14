import { describe, expect, it, vi } from 'vitest';
import { createNativeKeystoneTransport, projectNativeEvent } from './nativeTransport';
import { RunEventSequencer } from './sse';

const nativeFrame = (sequence: number, kind: string, payload: object = { reason: 'fixture' }) => ({
  id: String(sequence),
  event: 'keystone',
  data: JSON.stringify({
    schemaVersion: 1,
    runId: 'run',
    nodeId: 'root',
    sequence,
    timestamp: '2026-10-13T00:00:00Z',
    kind,
    payload,
  }),
});
const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });

describe('native Keystone transport', () => {
  it('rejects SPA HTML and unknown capability versions', async () => {
    const html = createNativeKeystoneTransport(
      vi
        .fn()
        .mockResolvedValue(
          new Response('<html>app</html>', { headers: { 'Content-Type': 'text/html' } }),
        ),
    );
    expect((await html.page.capabilities()).ok).toBe(false);
    const wrong = createNativeKeystoneTransport(
      vi
        .fn()
        .mockResolvedValue(
          json({ schemaVersion: 2, storage: 'ready', execution: 'ready', reason: null }),
        ),
    );
    expect((await wrong.page.capabilities()).ok).toBe(false);
  });
  it('reads a plain-text 401 or 403 from the auth middleware as denied, without its body', async () => {
    for (const [status, text] of [
      [401, 'Unauthorized'],
      [403, 'Forbidden'],
    ] as const)
      for (const headers of [{ 'Content-Type': 'text/plain; charset=utf-8' }, undefined]) {
        const response = new Response(text, { status, headers });
        const result = await createNativeKeystoneTransport(
          vi.fn().mockResolvedValue(response),
        ).page.capabilities();
        expect(result).toMatchObject({ ok: false, kind: 'denied' });
        expect(JSON.stringify(result)).not.toContain(text);
        expect(response.bodyUsed).toBe(false);
      }
  });
  it('never echoes a JSON denial body, and keeps other non-JSON failures invalid', async () => {
    const secret = 'synthetic-secret-in-error-body';
    const denied = await createNativeKeystoneTransport(
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: { code: secret } }), {
          status: 403,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    ).listInvestigations();
    expect(denied).toMatchObject({ ok: false, kind: 'denied' });
    expect(JSON.stringify(denied)).not.toContain(secret);
    const proxy = await createNativeKeystoneTransport(
      vi.fn().mockResolvedValue(new Response('Bad Gateway', { status: 502 })),
    ).page.capabilities();
    expect(proxy).toMatchObject({ ok: false, kind: 'invalid' });
    expect(JSON.stringify(proxy)).not.toContain('Bad Gateway');
  });
  it.each([
    ['queued', 'queued'],
    ['running', 'resolving_scope'],
  ] as const)(
    'accepts a cancellation acknowledgement while the native run is still %s',
    async (nativeStatus, browserStatus) => {
      const fetcher = vi
        .fn()
        .mockResolvedValue(json({ schemaVersion: 1, run: { status: nativeStatus } }));
      const result = await createNativeKeystoneTransport(fetcher).page.cancelRun(
        'investigation',
        'run',
      );
      // Cancellation may be acknowledged before the coordinator finishes teardown.
      // Preserve a nonterminal result until the terminal event arrives over SSE.
      expect(result).toEqual({ ok: true, value: { status: browserStatus } });
      expect(fetcher.mock.calls[0][0]).toBe(
        '/api/prism/v1/keystone/native/investigations/investigation/runs/run/cancel',
      );
      expect(fetcher.mock.calls[0][1]).toMatchObject({
        method: 'POST',
        credentials: 'include',
      });
    },
  );
  it.each(['completed', 'partial', 'failed', 'cancelled', 'interrupted'] as const)(
    'preserves the native %s status when cancellation races with termination',
    async (status) => {
      const fetcher = vi.fn().mockResolvedValue(json({ schemaVersion: 1, run: { status } }));
      const result = await createNativeKeystoneTransport(fetcher).page.cancelRun(
        'investigation',
        'run',
      );
      expect(result).toEqual({ ok: true, value: { status } });
      expect(fetcher.mock.calls[0][1].credentials).toBe('include');
    },
  );
  it.each([
    null,
    {},
    { schemaVersion: 2, run: { status: 'running' } },
    { schemaVersion: 1 },
    { schemaVersion: 1, run: null },
    { schemaVersion: 1, run: {} },
    ...[
      null,
      1,
      true,
      {},
      [],
      '',
      'unknown',
      'draft',
      'resolving_scope',
      'awaiting_confirmation',
      'querying',
      'composing',
    ].map((status) => ({
      schemaVersion: 1,
      run: { status },
    })),
  ])('rejects an invalid native cancellation response: %j', async (body) => {
    const result = await createNativeKeystoneTransport(
      vi.fn().mockResolvedValue(json(body)),
    ).page.cancelRun('investigation', 'run');
    expect(result.ok).toBe(false);
  });
  it('creates only the selected export evidence and pins server hash', async () => {
    const scope = {
      id: 'scope',
      datasets: ['logs'],
      start: '2026-09-13T00:00:00Z',
      end: '2026-10-13T00:00:00Z',
      timezone: 'UTC',
      filters: [],
    };
    const evidence = (id: string) => ({
      id,
      nodeId: 'parent',
      title: id,
      sql: '',
      datasets: ['logs'],
      start: scope.start,
      end: scope.end,
      executedAt: scope.end,
      status: 'empty',
      rowCount: 0,
      truncated: false,
      columns: [],
      rows: [],
    });
    const exportValue = {
      contextPolicy: 'direct_parent_v1',
      parentNodeId: 'parent',
      parentVersion: 1,
      parentStatus: 'completed',
      prompt: 'parent prompt',
      answer: 'parent answer',
      scope,
      evidence: [evidence('selected'), evidence('omitted')],
      omitted: [],
      truncated: false,
      exportHash: 'a'.repeat(64),
    };
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(json(exportValue))
      .mockResolvedValueOnce(json({ schemaVersion: 1, node: { id: 'child' } }))
      .mockResolvedValueOnce(json({ schemaVersion: 2 }));
    await createNativeKeystoneTransport(fetcher).createNode('inv', {
      parentNodeId: 'parent',
      parentVersion: 1,
      parentExportSha256: 'a'.repeat(64),
      contextPolicy: 'direct_parent_v1',
      intent: 'explore',
      prompt: 'child',
      scope: null,
      expectedSemanticRevision: 3,
      idempotencyKey: 'branch',
      exportedEvidenceIds: ['selected'],
    });
    const sent = JSON.parse(fetcher.mock.calls[1][1].body);
    expect(sent.exportedEvidenceIds).toEqual(['selected']);
    expect(sent.requestedScope).toBeNull();
    expect(sent.parentExportSha256).toBe('a'.repeat(64));
    expect(sent).not.toHaveProperty('context');
    expect(sent).not.toHaveProperty('graph');
    // Lost responses reuse the same scope identity and therefore the server fingerprint.
    const scopedFetcher = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url.endsWith('/export')) return Promise.resolve(json(exportValue));
      if (init?.method === 'POST')
        return Promise.resolve(new Response('unavailable', { status: 503 }));
      return Promise.resolve(json({ schemaVersion: 2 }));
    });
    const scoped = createNativeKeystoneTransport(scopedFetcher);
    const branchRequest = {
      parentNodeId: 'parent',
      parentVersion: 1,
      parentExportSha256: 'a'.repeat(64),
      contextPolicy: 'direct_parent_v1' as const,
      intent: 'explore' as const,
      prompt: 'child',
      scope,
      expectedSemanticRevision: 3,
      idempotencyKey: 'stable-branch',
    };
    await scoped.createNode('inv', branchRequest);
    await scoped.createNode('inv', branchRequest);
    const posts = scopedFetcher.mock.calls.filter(([, init]) => init?.method === 'POST');
    expect(posts).toHaveLength(2);
    expect(posts[0][1]?.body).toEqual(posts[1][1]?.body);
    expect(JSON.parse(posts[0][1]?.body as string).requestedScope.id).toBe('stable-branch');
  });
  it('projects every coordinator event into contiguous strict frames', () => {
    const sequencer = new RunEventSequencer('run');
    const source = [
      nativeFrame(1, 'queued'),
      nativeFrame(2, 'running'),
      nativeFrame(3, 'read_started'),
      nativeFrame(4, 'read_completed'),
      nativeFrame(5, 'provider_context_pinned'),
      nativeFrame(6, 'completed', { reason: 'completed', answer: 'Bounded answer' }),
    ];
    const projected = source.flatMap((frame) => projectNativeEvent(frame, 'run'));
    expect(projected[2]).toMatchObject({ kind: 'status', status: 'resolving_scope' });
    expect(projected[4]).toMatchObject({ kind: 'status', status: 'querying' });
    expect(projected[8]).toMatchObject({ kind: 'status', status: 'composing' });
    for (const event of projected)
      expect(
        sequencer.accept({ id: String(event.seq), event: 'keystone', data: JSON.stringify(event) })
          .type,
      ).toBe('apply');
    expect(projected.at(-2)).toMatchObject({ kind: 'answer_checkpoint', text: 'Bounded answer' });
    expect(sequencer.resumeAfter).toBe(12);
    expect(() => projectNativeEvent(nativeFrame(1, 'queued'), 'other')).toThrow();
  });
  it('replays the second browser frame from an odd cursor without losing terminal', async () => {
    const frame = nativeFrame(6, 'completed', { reason: 'completed', answer: 'Bounded answer' });
    const fetcher = vi.fn().mockResolvedValue(
      new Response(`id: 6\nevent: keystone\ndata: ${frame.data}\n\n`, {
        headers: { 'Content-Type': 'text/event-stream' },
      }),
    );
    const emit = vi.fn();
    const result = await createNativeKeystoneTransport(fetcher).page.runEvents(
      'inv',
      'run',
      11,
      emit,
      new AbortController().signal,
    );
    expect(result.ok).toBe(true);
    expect(fetcher.mock.calls[0][0]).toContain('?after=5');
    expect(emit).toHaveBeenCalledTimes(1);
    expect(JSON.parse(emit.mock.calls[0][0].data)).toMatchObject({ kind: 'terminal', seq: 12 });
  });
  it('rejects malformed live frames and wrong content types', async () => {
    for (const response of [
      new Response('<html/>', { headers: { 'Content-Type': 'text/html' } }),
      new Response('id: 1\ndata: {}\n\n', { headers: { 'Content-Type': 'text/event-stream' } }),
    ]) {
      const emit = vi.fn();
      const result = await createNativeKeystoneTransport(
        vi.fn().mockResolvedValue(response),
      ).page.runEvents('inv', 'run', 0, emit, new AbortController().signal);
      expect(result.ok).toBe(false);
      expect(emit).not.toHaveBeenCalled();
    }
  });
  it('sends credential only as a private raw body and never reflects an error body', async () => {
    const key = 'synthetic-provider-key-for-fixture';
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(json({ error: { code: key } }));
    const page = createNativeKeystoneTransport(fetcher).page;
    expect(await page.saveProviderCredential!(key, new AbortController().signal)).toEqual({
      ok: true,
      value: 'saved',
    });
    expect(fetcher.mock.calls[0][0]).not.toContain(key);
    expect(fetcher.mock.calls[0][1]).toMatchObject({
      method: 'PUT',
      credentials: 'include',
      body: key,
      headers: { 'Content-Type': 'application/octet-stream' },
    });
    const failure = await page.saveProviderCredential!(key, new AbortController().signal);
    expect(failure.ok).toBe(false);
    expect(JSON.stringify(failure)).not.toContain(key);
  });
});

it('reports a typed mid-stream revocation without forwarding event data', async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValue(
      new Response(
        'event: error\ndata: {"schemaVersion":1,"error":{"code":"authorization_revoked"}}\n\n',
        { headers: { 'Content-Type': 'text/event-stream' } },
      ),
    );
  const emit = vi.fn();
  const result = await createNativeKeystoneTransport(fetcher).page.runEvents(
    'inv',
    'run',
    0,
    emit,
    new AbortController().signal,
  );
  expect(result).toMatchObject({ ok: false, kind: 'denied' });
  expect(emit).not.toHaveBeenCalled();
});
