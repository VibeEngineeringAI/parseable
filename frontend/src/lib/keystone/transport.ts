import {
  decodeCapabilities,
  decodeCreatedNode,
  decodeEvidence,
  decodeGraph,
  decodeLayout,
  decodeParentExport,
  type Decoded,
} from './decode';
import { SseParser, type SseFrame } from './sse';
import type {
  CanvasLayout,
  CreateNodeRequest,
  Evidence,
  GraphNode,
  InvestigationGraph,
  KeystoneCapabilities,
  LayoutPatch,
  ParentExport,
  UnavailableReason,
} from './types';

export type TransportFailure =
  | { ok: false; kind: 'conflict'; message: string }
  | { ok: false; kind: 'gated'; reason: UnavailableReason; message: string }
  | { ok: false; kind: 'denied'; message: string }
  | { ok: false; kind: 'not_found'; message: string }
  | { ok: false; kind: 'invalid'; message: string }
  | { ok: false; kind: 'error'; message: string };

export type TransportResult<T> = { ok: true; value: T } | TransportFailure;

export interface CreatedNode {
  node: GraphNode;
  runId: string | null;
  semanticRevision: number;
}

/**
 * Everything the Keystone UI asks of the server. Geometry and semantic calls are
 * separate methods with separate revisions; no presentation call starts a run.
 */
export interface KeystoneTransport {
  capabilities(): Promise<TransportResult<KeystoneCapabilities>>;
  graph(investigationId: string): Promise<TransportResult<InvestigationGraph>>;
  layout(
    investigationId: string,
    nodeIds: ReadonlySet<string>,
  ): Promise<TransportResult<CanvasLayout>>;
  patchLayout(investigationId: string, patch: LayoutPatch): Promise<TransportResult<CanvasLayout>>;
  /** The direct parent's immutable export; never an ancestor chain. */
  parentExport(investigationId: string, nodeId: string): Promise<TransportResult<ParentExport>>;
  evidence(
    investigationId: string,
    nodeId: string,
    signal?: AbortSignal,
  ): Promise<TransportResult<Evidence[]>>;
  createNode(
    investigationId: string,
    request: CreateNodeRequest,
  ): Promise<TransportResult<CreatedNode>>;
}

/**
 * Delivers raw run-event frames. `replay` re-delivers every frame after `after`
 * for a run, which the client uses to fill a sequence gap.
 */
export interface RunEventSource {
  subscribe(listener: (runId: string, frame: SseFrame) => void): () => void;
  replay(runId: string, after: number): void;
}

export const KEYSTONE_API = '/api/prism/v1/keystone';

/**
 * Reads `GET /runs/{runId}/events?after=` as authenticated SSE over fetch until the
 * stream ends or `signal` aborts. Frames are handed over unsequenced; callers pass
 * them through a RunEventSequencer.
 */
export async function streamRunEvents(
  runId: string,
  after: number,
  onFrame: (frame: SseFrame) => void,
  signal: AbortSignal,
  fetcher: typeof fetch = (input, init) => fetch(input, init),
  base = KEYSTONE_API,
): Promise<TransportResult<'ended'>> {
  let response: Response;
  try {
    response = await fetcher(`${base}/runs/${encodeURIComponent(runId)}/events?after=${after}`, {
      credentials: 'include',
      headers: { Accept: 'text/event-stream' },
      signal,
    });
  } catch {
    return { ok: false, kind: 'error', message: 'The run event stream could not be opened.' };
  }
  if (!response.ok)
    return failure(response.status, `Event stream failed (${response.status}).`, null);
  if (!(response.headers.get('content-type') ?? '').includes('text/event-stream') || !response.body)
    return { ok: false, kind: 'invalid', message: 'The server did not return an event stream.' };
  const parser = new SseParser();
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const frame of parser.push(value)) onFrame(frame);
    }
    for (const frame of parser.end()) onFrame(frame);
  } catch {
    if (signal.aborted) return { ok: true, value: 'ended' };
    return { ok: false, kind: 'error', message: 'The run event stream was interrupted.' };
  }
  return { ok: true, value: 'ended' };
}

const REASONS: UnavailableReason[] = [
  'backend_missing',
  'provider_unconfigured',
  'provider_disabled',
  'tools_unavailable',
  'permission_denied',
  'topology_unsupported',
];

function failure(status: number, message: string, code: unknown): TransportFailure {
  if (status === 409 || status === 412) return { ok: false, kind: 'conflict', message };
  if (status === 401 || status === 403) return { ok: false, kind: 'denied', message };
  // Inaccessible objects are reported as missing, without disclosing existence.
  if (status === 404) return { ok: false, kind: 'not_found', message };
  if (status === 501 || status === 503)
    return {
      ok: false,
      kind: 'gated',
      reason: REASONS.find((item) => item === code) ?? 'backend_missing',
      message,
    };
  return { ok: false, kind: 'error', message };
}

function evidenceList(nodeId: string) {
  return (value: unknown): Decoded<Evidence[]> => {
    if (!Array.isArray(value)) return { ok: false, error: 'evidence: expected an array' };
    const items: Evidence[] = [];
    for (const item of value) {
      const decoded = decodeEvidence(item);
      if (!decoded.ok) return decoded;
      if (decoded.value.nodeId !== nodeId)
        return { ok: false, error: 'evidence: item belongs to another node' };
      items.push(decoded.value);
    }
    return { ok: true, value: items };
  };
}

/** Fetch-based transport for the proposed `/api/prism/v1/keystone` contract. */
export function createHttpKeystoneTransport(
  fetcher: typeof fetch = (input, init) => fetch(input, init),
  base = KEYSTONE_API,
): KeystoneTransport {
  async function call<T>(
    path: string,
    decode: (value: unknown) => Decoded<T>,
    init: RequestInit = {},
  ): Promise<TransportResult<T>> {
    let response: Response;
    try {
      response = await fetcher(`${base}${path}`, {
        ...init,
        credentials: 'include',
        headers: { Accept: 'application/json', ...(init.headers as Record<string, string>) },
      });
    } catch {
      return { ok: false, kind: 'error', message: 'Keystone could not be reached.' };
    }
    // A single-page-app fallback answers 200 text/html; that is not API support.
    const json = (response.headers.get('content-type') ?? '').includes('application/json');
    const body: unknown = json ? await response.json().catch(() => undefined) : undefined;
    if (!response.ok) {
      const envelope = (body ?? {}) as { message?: unknown; code?: unknown };
      const message =
        typeof envelope.message === 'string'
          ? envelope.message
          : `Request failed (${response.status}).`;
      return failure(response.status, message, envelope.code);
    }
    if (!json)
      return {
        ok: false,
        kind: 'gated',
        reason: 'backend_missing',
        message: 'This server does not provide the Keystone API.',
      };
    const decoded = decode(body);
    return decoded.ok
      ? { ok: true, value: decoded.value }
      : { ok: false, kind: 'invalid', message: `Unexpected Keystone response: ${decoded.error}` };
  }
  const investigation = (id: string) => `/investigations/${encodeURIComponent(id)}`;
  const node = (id: string, nodeId: string) =>
    `${investigation(id)}/nodes/${encodeURIComponent(nodeId)}`;
  return {
    capabilities: () => call('/capabilities', decodeCapabilities),
    graph: (id) => call(`${investigation(id)}/graph`, decodeGraph),
    layout: (id, nodeIds) =>
      call(`${investigation(id)}/layout`, (value) => decodeLayout(value, nodeIds)),
    patchLayout: (id, patch) =>
      call(`${investigation(id)}/layout`, (value) => decodeLayout(value), {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'If-Match': `"${patch.expectedLayoutRevision}"`,
        },
        body: JSON.stringify({ nodes: patch.nodes }),
      }),
    parentExport: (id, nodeId) => call(`${node(id, nodeId)}/export`, decodeParentExport),
    evidence: (id, nodeId, signal) =>
      call(`${node(id, nodeId)}/evidence`, evidenceList(nodeId), { signal }),
    createNode: (id, request) => {
      const { idempotencyKey, expectedSemanticRevision, ...body } = request;
      return call(`${investigation(id)}/nodes`, decodeCreatedNode, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
          'If-Match': `"${expectedSemanticRevision}"`,
        },
        body: JSON.stringify(body),
      });
    },
  };
}
