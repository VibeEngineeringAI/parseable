// Keystone investigation contracts as seen by the browser. The server owns identity,
// tenancy, ownership and RBAC; none of those are client-supplied fields here.

export const CONTEXT_POLICY = 'direct_parent_v1' as const;
export type ContextPolicy = typeof CONTEXT_POLICY;

export type NodeKind = 'question' | 'visualization';

/** How a child was created. Both actions use the selected node as the direct parent. */
export type BranchIntent = 'root' | 'follow_up' | 'explore';

export type NodeStatus =
  | 'draft'
  | 'queued'
  | 'resolving_scope'
  | 'awaiting_confirmation'
  | 'querying'
  | 'composing'
  | 'completed'
  | 'partial'
  | 'cancelled'
  | 'failed'
  | 'interrupted';

export const NODE_STATUSES: readonly NodeStatus[] = [
  'draft',
  'queued',
  'resolving_scope',
  'awaiting_confirmation',
  'querying',
  'composing',
  'completed',
  'partial',
  'cancelled',
  'failed',
  'interrupted',
];

export const ACTIVE_STATUSES: readonly NodeStatus[] = [
  'queued',
  'resolving_scope',
  'awaiting_confirmation',
  'querying',
  'composing',
];

/** An approved, absolute scope. Inherited unchanged unless a scope change is approved. */
export interface ScopeVersion {
  id: string;
  datasets: string[];
  /** RFC 3339 UTC instants. */
  start: string;
  end: string;
  timezone: string;
  filters: string[];
}

export interface GraphNode {
  id: string;
  kind: NodeKind;
  intent: BranchIntent;
  parentId: string | null;
  /** The parent version this node's context was built from; null for the root. */
  parentVersion: number | null;
  version: number;
  title: string;
  prompt: string;
  /** Completed or checkpointed answer text; null until the run produces one. */
  answer: string | null;
  status: NodeStatus;
  scope: ScopeVersion;
  /** True when this node's scope differs from its parent's approved scope. */
  scopeChanged: boolean;
  evidenceCount: number;
  /** Hash of the resolved context manifest the run used; null before a run starts. */
  contextHash: string | null;
  createdAt: string;
  /** Native selected run, absent in older standalone fixtures. */
  runId?: string | null;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  intent: Exclude<BranchIntent, 'root'>;
}

/** Semantic graph. Edges are derived from parent links; the client never authors them. */
export interface InvestigationGraph {
  schemaVersion: 1;
  investigationId: string;
  title: string;
  semanticRevision: number;
  rootNodeId: string;
  nodes: GraphNode[];
}

export interface NodeGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
  pinned: boolean;
  collapsed?: boolean;
  expandedHeight?: number;
}

/** Presentation geometry with its own revision, independent of the semantic graph. */
export interface CanvasLayout {
  schemaVersion: 1;
  investigationId: string;
  layoutRevision: number;
  nodes: Record<string, NodeGeometry>;
}

export type EvidenceStatus = 'ok' | 'empty' | 'denied' | 'error' | 'expired';
export type CellValue = string | number | boolean | null;

export interface Evidence {
  id: string;
  nodeId: string;
  title: string;
  sql: string;
  datasets: string[];
  start: string;
  end: string;
  executedAt: string;
  status: EvidenceStatus;
  rowCount: number;
  truncated: boolean;
  columns: string[];
  rows: CellValue[][];
}

/**
 * The immutable package a parent exports to its direct children: its own prompt,
 * completed answer, approved scope and explicitly exported evidence. Nothing else.
 */
export interface ParentExport {
  contextPolicy: ContextPolicy;
  parentNodeId: string;
  parentVersion: number;
  parentStatus: NodeStatus;
  prompt: string;
  answer: string;
  scope: ScopeVersion;
  evidence: Evidence[];
  /** Material deliberately left out, described for the preview. */
  omitted: string[];
  truncated: boolean;
  /** Server hash of the native immutable export, distinct from preview JSON. */
  exportHash?: string;
}

/** A parent export pinned at composer open: exact canonical bytes and their hash. */
export interface PinnedParentExport {
  value: ParentExport;
  bytes: string;
  sha256: string;
}

export type ReadinessState = 'ready' | 'unconfigured' | 'disabled' | 'degraded' | 'unavailable';

export type UnavailableReason =
  | 'backend_missing'
  | 'provider_unconfigured'
  | 'provider_disabled'
  | 'tools_unavailable'
  | 'permission_denied'
  | 'topology_unsupported';

export interface KeystoneCapabilities {
  schemaVersion: 1;
  generative: { state: ReadinessState; reason: UnavailableReason | null };
  tools: { state: ReadinessState; reason: UnavailableReason | null };
  actions: {
    read: boolean;
    run: boolean;
    branch: boolean;
    editLayout: boolean;
    manageProviders: boolean;
  };
}

export type RunEventKind =
  'status' | 'answer_delta' | 'answer_checkpoint' | 'evidence' | 'terminal';

interface RunEventBase {
  schemaVersion: 1;
  runId: string;
  nodeId: string;
  seq: number;
}

export type RunEvent =
  | (RunEventBase & { kind: 'status'; status: NodeStatus })
  | (RunEventBase & { kind: 'answer_delta'; text: string })
  | (RunEventBase & { kind: 'answer_checkpoint'; text: string })
  | (RunEventBase & { kind: 'evidence'; evidence: Evidence })
  | (RunEventBase & {
      kind: 'terminal';
      status: Extract<NodeStatus, 'completed' | 'partial' | 'cancelled' | 'failed' | 'interrupted'>;
      reason: string | null;
    });

/** Body of the branch command. The server rebuilds context from these IDs. */
export interface CreateNodeRequest {
  parentNodeId: string;
  parentVersion: number;
  parentExportSha256: string;
  exportedEvidenceIds?: string[];
  contextPolicy: ContextPolicy;
  intent: Exclude<BranchIntent, 'root'>;
  prompt: string;
  /** Present only for an approved scope change; otherwise the parent scope is inherited. */
  scope: Omit<ScopeVersion, 'id'> | null;
  expectedSemanticRevision: number;
  idempotencyKey: string;
}

export interface LayoutPatch {
  expectedLayoutRevision: number;
  nodes: Record<string, NodeGeometry>;
}
