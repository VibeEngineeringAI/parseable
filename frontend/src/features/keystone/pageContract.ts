// The narrow interface the full Keystone page needs from the server. The native
// transport in lib/keystone adapts the `/keystone/native` routes to it; the page
// never sees native DTOs, and nothing here is filled in by the browser.

import type { SseFrame } from '../../lib/keystone/sse';
import type { KeystoneTransport, TransportResult } from '../../lib/keystone/transport';
import type {
  GraphNode,
  KeystoneCapabilities,
  NodeStatus,
  ScopeVersion,
} from '../../lib/keystone/types';

export type StorageState = 'ready' | 'degraded' | 'unavailable';

/**
 * Why storage is not ready: the node's mode does not serve investigations, its
 * repository stopped accepting writes, or no repository is configured.
 */
export type StorageReason = 'mode_disabled' | 'repository_degraded' | 'repository_unconfigured';

/**
 * Why questions cannot run. Known codes have specific copy; any other server code is
 * shown generically, never treated as ready.
 */
export type ExecutionReason =
  | 'execution_unavailable'
  | 'query_bridge_unavailable'
  | 'provider_unconfigured'
  | 'provider_disabled'
  | 'secret_store_unavailable'
  | 'permission_denied'
  | 'topology_unsupported'
  | (string & {});

export interface KeystonePageCapabilities {
  /** Durable storage: gates listing, creating and reopening investigations. */
  storage: { state: StorageState; reason: StorageReason | null };
  /** Run execution, reported independently of storage. */
  execution: { state: 'ready' | 'unavailable'; reason: ExecutionReason | null };
  /** Per-investigation capabilities passed to the workspace. */
  workspace: KeystoneCapabilities;
  provider?: { model: string; apiBase: string; credentialEntry: boolean } | null;
}

export interface InvestigationSummary {
  id: string;
  title: string;
  rootNodeId: string;
  /** RFC 3339 UTC. */
  updatedAt: string;
}

export interface InvestigationPage {
  items: InvestigationSummary[];
  /** Cursor for the next page, or null at the end. */
  next: string | null;
}

/**
 * Creates an investigation whose root question is a draft. Creating never starts a
 * run. The scope is already absolute: the browser froze the bounds the user saw.
 */
export interface CreateInvestigationRequest {
  title: string;
  prompt: string;
  scope: Omit<ScopeVersion, 'id'>;
  idempotencyKey: string;
}

export interface StartRunRequest {
  nodeId: string;
  /** The exact node version the user chose to run. */
  nodeVersion: number;
  /** Semantic revision the user saw; a changed investigation is a conflict. */
  expectedRevision: number;
  idempotencyKey: string;
}

export interface KeystonePageTransport {
  saveProviderCredential?(key: string, signal: AbortSignal): Promise<TransportResult<'saved'>>;
  capabilities(signal?: AbortSignal): Promise<TransportResult<KeystonePageCapabilities>>;
  listInvestigations(
    after: string | null,
    signal?: AbortSignal,
  ): Promise<TransportResult<InvestigationPage>>;
  createInvestigation(
    request: CreateInvestigationRequest,
  ): Promise<TransportResult<InvestigationSummary>>;
  /** Graph, layout, export, evidence and branch calls for one investigation. */
  workspace: KeystoneTransport;
  startRun(
    investigationId: string,
    request: StartRunRequest,
  ): Promise<TransportResult<{ runId: string }>>;
  /** REST cancel. Resolves with the run's status after the request. */
  cancelRun(
    investigationId: string,
    runId: string,
  ): Promise<TransportResult<{ status: NodeStatus }>>;
  /**
   * One SSE read of `runs/{runId}/events?after=`. Frames carry `RunEvent` JSON with
   * `id` equal to `seq`. Resolves when the stream ends or `signal` aborts.
   */
  runEvents(
    investigationId: string,
    runId: string,
    after: number,
    onFrame: (frame: SseFrame) => void,
    signal: AbortSignal,
  ): Promise<TransportResult<'ended'>>;
}

/** A question saved but never run. */
export function isDraft(node: Pick<GraphNode, 'status'>): boolean {
  return node.status === 'draft';
}

/** The run attached to the node version, when the server reports one. */
export function nodeRunId(node: Pick<GraphNode, 'runId'>): string | null {
  return node.runId ?? null;
}
