import {
  decodeCapabilities,
  decodeGraph,
  decodeLayout,
  decodeParentExport,
  decodeEvidence,
} from './decode';
import type { Decoded } from './decode';
import type { KeystoneTransport, TransportResult } from './transport';
import type { ScopeVersion, NodeStatus, RunEvent } from './types';
import { SseParser, type SseFrame } from './sse';
import type { KeystonePageTransport, StorageReason } from '../../features/keystone/pageContract';
import { decodeRunEvent } from './decode';

export interface InvestigationSummary {
  id: string;
  title: string;
  updatedAt: string;
  rootNodeId: string;
  semanticRevision: number;
}
export interface CreateInvestigationRequest {
  title: string;
  prompt: string;
  scope: Omit<ScopeVersion, 'id'>;
  idempotencyKey: string;
}
export interface StartRunRequest {
  nodeId: string;
  nodeVersion: number;
  expectedRevision: number;
  idempotencyKey: string;
}
export interface NativeKeystoneTransport extends KeystoneTransport {
  listInvestigations(
    after?: string,
    signal?: AbortSignal,
  ): Promise<TransportResult<{ investigations: InvestigationSummary[]; next: string | null }>>;
  createInvestigation(
    request: CreateInvestigationRequest,
  ): Promise<TransportResult<InvestigationSummary>>;
  startRun(
    investigationId: string,
    request: StartRunRequest,
  ): Promise<TransportResult<{ runId: string }>>;
  cancelRun(
    investigationId: string,
    runId: string,
  ): Promise<TransportResult<{ status: NodeStatus }>>;
  page: KeystonePageTransport;
}

const BASE = '/api/prism/v1/keystone/native';
const invalid = <T>(): TransportResult<T> => ({
  ok: false,
  kind: 'invalid',
  message: 'The server returned an invalid Keystone response.',
});
function nativeScope(scope: Omit<ScopeVersion, 'id'>, id: string = crypto.randomUUID()) {
  if (scope.filters.length) throw new Error('Structured scope filters are not yet supported.');
  return {
    id,
    datasets: scope.datasets,
    absoluteStart: scope.start,
    absoluteEnd: scope.end,
    timezone: scope.timezone,
    filters: {},
    approvedBy: 'server',
  };
}

/** Native API adapter: identity and context bytes are never supplied by the browser. */
export function createNativeKeystoneTransport(
  fetcher: typeof fetch = (input, init) => fetch(input, init),
): NativeKeystoneTransport {
  const path = (id: string) => `/investigations/${encodeURIComponent(id)}`;
  async function request<T>(
    url: string,
    decode: (value: unknown) => Decoded<T>,
    init: RequestInit = {},
  ): Promise<TransportResult<T>> {
    try {
      const response = await fetcher(BASE + url, {
        ...init,
        credentials: 'include',
        headers: { Accept: 'application/json', ...init.headers },
      });
      // Auth middleware answers in plain text before any Keystone handler runs, so a
      // denial is read from the status alone and its body is never read.
      if (response.status === 401 || response.status === 403)
        return { ok: false, kind: 'denied', message: 'Keystone access was denied.' };
      if (!(response.headers.get('content-type') ?? '').includes('application/json'))
        return invalid();
      const body = await response.json();
      if (!response.ok)
        return {
          ok: false,
          kind:
            response.status === 409 ? 'conflict' : response.status === 404 ? 'not_found' : 'error',
          message:
            typeof body?.error?.code === 'string'
              ? body.error.code.replaceAll('_', ' ')
              : 'Keystone request failed.',
        };
      const result = decode(body);
      return result.ok ? { ok: true, value: result.value } : invalid();
    } catch {
      return { ok: false, kind: 'error', message: 'Keystone could not be reached.' };
    }
  }
  const json = (body: unknown, key?: string): RequestInit => ({
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) },
    body: JSON.stringify(body),
  });
  function summary(v: unknown): Decoded<InvestigationSummary> {
    if (!v || typeof v !== 'object') return { ok: false, error: 'summary' };
    const o = v as Record<string, unknown>;
    if (
      !['id', 'title', 'updatedAt', 'rootNodeId'].every((k) => typeof o[k] === 'string') ||
      !Number.isSafeInteger(o.semanticRevision)
    )
      return { ok: false, error: 'summary' };
    return {
      ok: true,
      value: {
        id: o.id as string,
        title: o.title as string,
        updatedAt: o.updatedAt as string,
        rootNodeId: o.rootNodeId as string,
        semanticRevision: o.semanticRevision as number,
      },
    };
  }
  const transport: NativeKeystoneTransport = {
    capabilities: () => request('/ui/capabilities', decodeCapabilities),
    graph: (id) => request(path(id) + '/graph', decodeGraph),
    layout: (id, ids) => request(path(id) + '/presentation', (v) => decodeLayout(v, ids)),
    patchLayout: async (id, patch) => {
      const result = await request(
        path(id) + '/layout',
        (v) => {
          const o = v as {
            schemaVersion?: unknown;
            layout?: { investigationId?: unknown; revision?: unknown; nodes?: unknown };
          };
          return decodeLayout({
            schemaVersion: o.schemaVersion,
            investigationId: o.layout?.investigationId,
            layoutRevision: o.layout?.revision,
            nodes: o.layout?.nodes,
          });
        },
        {
          ...json({ expectedRevision: patch.expectedLayoutRevision, nodes: patch.nodes }),
          method: 'PUT',
        },
      );
      return result;
    },
    parentExport: (id, node) =>
      request(`${path(id)}/nodes/${encodeURIComponent(node)}/export`, decodeParentExport),
    evidence: (id, node, signal) =>
      request(
        `${path(id)}/nodes/${encodeURIComponent(node)}/evidence`,
        (v) => {
          if (!Array.isArray(v)) return { ok: false, error: 'evidence' };
          const items = v.map(decodeEvidence);
          if (items.some((i) => !i.ok || i.value.nodeId !== node))
            return { ok: false, error: 'evidence' };
          return { ok: true, value: items.flatMap((i) => (i.ok ? [i.value] : [])) };
        },
        { signal },
      ),
    createNode: async (id, body) => {
      const exported = await transport.parentExport(id, body.parentNodeId);
      if (!exported.ok) return exported;
      if (
        exported.value.exportHash !== body.parentExportSha256 ||
        exported.value.parentVersion !== body.parentVersion
      )
        return {
          ok: false,
          kind: 'conflict',
          message: 'The parent export changed. Reopen the branch preview.',
        };
      let requestedScope;
      try {
        requestedScope = body.scope ? nativeScope(body.scope, body.idempotencyKey) : null;
      } catch {
        return invalid();
      }
      const result = await request(
        path(id) + '/nodes',
        (v) => {
          const o = v as { schemaVersion?: unknown; node?: { id?: unknown } };
          return o.schemaVersion === 1 && typeof o.node?.id === 'string'
            ? { ok: true, value: o.node.id }
            : { ok: false, error: 'node' };
        },
        json(
          {
            parentNodeId: body.parentNodeId,
            parentVersion: body.parentVersion,
            parentExportSha256: body.parentExportSha256,
            contextPolicy: body.contextPolicy,
            intent: body.intent,
            prompt: body.prompt,
            expectedRevision: body.expectedSemanticRevision,
            requestedScope,
            scopeChangeReviewed: body.scope !== null,
            exportedEvidenceIds: body.exportedEvidenceIds ?? [],
          },
          body.idempotencyKey,
        ),
      );
      if (!result.ok) return result;
      const graph = await transport.graph(id);
      if (!graph.ok) return graph;
      const node = graph.value.nodes.find((n) => n.id === result.value);
      return node
        ? {
            ok: true,
            value: {
              node,
              runId: node.runId ?? null,
              semanticRevision: graph.value.semanticRevision,
            },
          }
        : invalid();
    },
    listInvestigations: (after, signal) =>
      request(
        '/investigations' + (after ? `?after=${encodeURIComponent(after)}` : ''),
        (v) => {
          const o = v as { schemaVersion?: unknown; investigations?: unknown; next?: unknown };
          if (
            o.schemaVersion !== 1 ||
            !Array.isArray(o.investigations) ||
            (o.next !== null && typeof o.next !== 'string')
          )
            return { ok: false, error: 'list' };
          const rows = o.investigations.map(summary);
          if (rows.some((r) => !r.ok)) return { ok: false, error: 'list' };
          return {
            ok: true,
            value: {
              investigations: rows.flatMap((r) => (r.ok ? [r.value] : [])),
              next: o.next as string | null,
            },
          };
        },
        { signal },
      ),
    createInvestigation: async (body) => {
      let scope;
      try {
        scope = nativeScope(body.scope, body.idempotencyKey);
      } catch {
        return invalid();
      }
      return request(
        '/investigations',
        (v) => {
          const o = v as { schemaVersion?: unknown; investigation?: unknown };
          return o.schemaVersion === 1 ? summary(o.investigation) : { ok: false, error: 'create' };
        },
        json({ title: body.title, prompt: body.prompt, scope }, body.idempotencyKey),
      );
    },
    startRun: (id, body) =>
      request(
        path(id) + '/runs',
        (v) => {
          const o = v as { schemaVersion?: unknown; run?: { id?: unknown } };
          return o.schemaVersion === 1 && typeof o.run?.id === 'string'
            ? { ok: true, value: { runId: o.run.id } }
            : { ok: false, error: 'run' };
        },
        json(
          {
            nodeId: body.nodeId,
            nodeVersion: body.nodeVersion,
            expectedRevision: body.expectedRevision,
          },
          body.idempotencyKey,
        ),
      ),
    cancelRun: (id, run) =>
      request(
        `${path(id)}/runs/${encodeURIComponent(run)}/cancel`,
        (v) => {
          const o = v as { schemaVersion?: unknown; run?: { status?: unknown } };
          return o.schemaVersion === 1 &&
            typeof o.run?.status === 'string' &&
            ['completed', 'partial', 'failed', 'cancelled', 'interrupted'].includes(o.run.status)
            ? { ok: true, value: { status: o.run.status as NodeStatus } }
            : { ok: false, error: 'run' };
        },
        json({}),
      ),
    page: undefined as unknown as KeystonePageTransport,
  };
  transport.page = {
    workspace: transport,
    saveProviderCredential: async (key, signal) => {
      try {
        const response = await fetcher(BASE + '/providers/credentials', {
          method: 'PUT',
          credentials: 'include',
          headers: { 'Content-Type': 'application/octet-stream', Accept: 'application/json' },
          body: key,
          signal,
        });
        return response.status === 204
          ? { ok: true, value: 'saved' }
          : {
              ok: false,
              kind: response.status === 401 || response.status === 403 ? 'denied' : 'error',
              message:
                response.status === 400
                  ? 'The credential format is invalid. Enter the API key without spaces.'
                  : 'The credential could not be saved. Check administrator access and server configuration.',
            };
      } catch {
        return { ok: false, kind: 'error', message: 'The credential could not be saved.' };
      }
    },
    capabilities: async (signal) => {
      const native = await request(
        '/capabilities',
        (value) => {
          if (!value || typeof value !== 'object') return { ok: false, error: 'capabilities' };
          const o = value as Record<string, unknown>;
          if (
            o.schemaVersion !== 1 ||
            !['ready', 'degraded', 'unavailable'].includes(o.storage as string) ||
            !['ready', 'unavailable'].includes(o.execution as string) ||
            !(o.reason === null || typeof o.reason === 'string')
          )
            return { ok: false, error: 'capabilities' };
          const provider = o.provider as
            { model?: unknown; apiBase?: unknown; credentialEntry?: unknown } | null | undefined;
          if (
            provider !== null &&
            provider !== undefined &&
            (typeof provider !== 'object' ||
              typeof provider.model !== 'string' ||
              provider.apiBase !== 'https://openrouter.ai/api/v1' ||
              typeof provider.credentialEntry !== 'boolean')
          )
            return { ok: false, error: 'provider' };
          // A node whose mode does not serve investigations has no usable storage here,
          // whatever its repository reports.
          const storage =
            o.disabled === true
              ? 'unavailable'
              : (o.storage as 'ready' | 'degraded' | 'unavailable');
          const storageReason: StorageReason | null =
            o.disabled === true
              ? 'mode_disabled'
              : storage === 'degraded'
                ? 'repository_degraded'
                : storage === 'unavailable'
                  ? 'repository_unconfigured'
                  : null;
          return {
            ok: true,
            value: {
              provider: provider
                ? {
                    model: provider.model as string,
                    apiBase: provider.apiBase as string,
                    credentialEntry: provider.credentialEntry as boolean,
                  }
                : null,
              storage: { state: storage, reason: storageReason },
              execution: {
                state: o.execution as 'ready' | 'unavailable',
                reason: o.reason as string | null,
              },
            },
          };
        },
        { signal },
      );
      if (!native.ok) return native;
      const workspace = await request('/ui/capabilities', decodeCapabilities, { signal });
      return workspace.ok
        ? { ok: true, value: { ...native.value, workspace: workspace.value } }
        : workspace;
    },
    listInvestigations: async (after, signal) => {
      const result = await transport.listInvestigations(after ?? undefined, signal);
      return result.ok
        ? { ok: true, value: { items: result.value.investigations, next: result.value.next } }
        : result;
    },
    createInvestigation: transport.createInvestigation,
    startRun: transport.startRun,
    cancelRun: transport.cancelRun,
    runEvents: (id, run, after, onFrame, signal) =>
      readNativeEvents(fetcher, BASE + path(id), run, after, onFrame, signal),
  };
  return transport;
}

/** Each durable native event has two deterministic browser frames. Replaying an odd
 * cursor re-reads that native event and emits only its second frame. */
export function projectNativeEvent(frame: SseFrame, runId: string): RunEvent[] {
  const v: unknown = JSON.parse(frame.data);
  if (!v || typeof v !== 'object') throw new Error('Invalid event');
  const e = v as Record<string, unknown>;
  if (
    e.schemaVersion !== 1 ||
    e.runId !== runId ||
    typeof e.nodeId !== 'string' ||
    !e.nodeId ||
    !Number.isSafeInteger(e.sequence) ||
    (e.sequence as number) < 1 ||
    (e.sequence as number) > Number.MAX_SAFE_INTEGER / 2 ||
    frame.id !== String(e.sequence) ||
    !e.payload ||
    typeof e.payload !== 'object'
  )
    throw new Error('Invalid event');
  const payload = e.payload as Record<string, unknown>;
  const base = {
    schemaVersion: 1 as const,
    runId,
    nodeId: e.nodeId,
    seq: (e.sequence as number) * 2 - 1,
  };
  const terminal = ['completed', 'partial', 'failed', 'cancelled', 'interrupted'].includes(
    e.kind as string,
  );
  let pair: unknown[];
  if (terminal) {
    if (!(payload.answer === null || typeof payload.answer === 'string'))
      throw new Error('Missing answer checkpoint');
    pair = [
      { ...base, kind: 'answer_checkpoint', text: payload.answer ?? '' },
      {
        ...base,
        seq: base.seq + 1,
        kind: 'terminal',
        status: e.kind,
        reason: payload.reason ?? null,
      },
    ];
  } else {
    const status =
      e.kind === 'queued'
        ? 'queued'
        : e.kind === 'read_started' || e.kind === 'read_completed'
          ? 'querying'
          : e.kind === 'running'
            ? 'resolving_scope'
            : e.kind === 'provider_context_pinned'
              ? 'composing'
              : null;
    if (!status) throw new Error('Unsupported native event');
    pair = [
      e.kind === 'read_completed' && payload.evidence
        ? { ...base, kind: 'evidence', evidence: payload.evidence }
        : { ...base, kind: 'status', status },
      { ...base, seq: base.seq + 1, kind: 'status', status },
    ];
  }
  return pair.map((value) => {
    const result = decodeRunEvent(value);
    if (!result.ok) throw new Error(result.error);
    return result.value;
  });
}
async function readNativeEvents(
  fetcher: typeof fetch,
  base: string,
  run: string,
  after: number,
  onFrame: (frame: SseFrame) => void,
  signal: AbortSignal,
): Promise<TransportResult<'ended'>> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let streamFailure: TransportResult<'ended'> | undefined;
  try {
    const response = await fetcher(
      `${base}/runs/${encodeURIComponent(run)}/events?after=${Math.floor(after / 2)}`,
      { credentials: 'include', headers: { Accept: 'text/event-stream' }, signal },
    );
    if (!response.ok)
      return {
        ok: false,
        kind: response.status === 401 || response.status === 403 ? 'denied' : 'error',
        message: 'The live run stream is unavailable.',
      };
    if (
      !(response.headers.get('content-type') ?? '').includes('text/event-stream') ||
      !response.body
    )
      return invalid();
    reader = response.body.getReader();
    const parser = new SseParser();
    let sinceFrame = 0;
    const emit = (frames: SseFrame[]) => {
      for (const frame of frames) {
        sinceFrame = 0;
        if (frame.event === 'error') {
          const value: unknown = JSON.parse(frame.data);
          if (
            !value ||
            typeof value !== 'object' ||
            (value as { schemaVersion?: unknown }).schemaVersion !== 1
          )
            throw new Error('Invalid stream error');
          const code = (value as { error?: { code?: unknown } }).error?.code;
          if (code !== 'authorization_revoked' && code !== 'stream_unavailable')
            throw new Error('Invalid stream error');
          streamFailure = {
            ok: false,
            kind: code === 'authorization_revoked' ? 'denied' : 'error',
            message:
              code === 'authorization_revoked'
                ? 'Access to this run has expired or been revoked.'
                : 'The live run stream is unavailable.',
          };
          return;
        }
        if (streamFailure) return;
        for (const event of projectNativeEvent(frame, run))
          if (event.seq > after)
            onFrame({ id: String(event.seq), event: 'keystone', data: JSON.stringify(event) });
      }
    };
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) {
        emit(parser.end());
        break;
      }
      sinceFrame += chunk.value.byteLength;
      if (sinceFrame > 1024 * 1024) return invalid();
      emit(parser.push(chunk.value));
      if (streamFailure) return streamFailure;
    }
    return streamFailure ?? { ok: true, value: 'ended' };
  } catch {
    return signal.aborted ? { ok: true, value: 'ended' } : invalid();
  } finally {
    await reader?.cancel().catch(() => {});
    reader?.releaseLock();
  }
}
export function createNativeKeystonePageTransport(fetcher?: typeof fetch): KeystonePageTransport {
  return createNativeKeystoneTransport(fetcher).page;
}
