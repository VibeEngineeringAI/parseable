import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Button, Spinner } from '../../components/ui';
import { pinParentExport } from '../../lib/keystone/context';
import { neighbours } from '../../lib/keystone/graph';
import {
  FormatLayoutError,
  formatLayout,
  resolveLayout,
  treeLayout,
} from '../../lib/keystone/layout';
import { RunEventSequencer } from '../../lib/keystone/sse';
import { applyRunEvent, isTerminal } from '../../lib/keystone/streaming';
import type {
  KeystoneTransport,
  RunEventSource,
  TransportFailure,
  TransportResult,
} from '../../lib/keystone/transport';
import {
  ACTIVE_STATUSES,
  type CanvasLayout,
  type GraphNode,
  type InvestigationGraph,
  type KeystoneCapabilities,
  type NodeStatus,
  type UnavailableReason,
} from '../../lib/keystone/types';
import { BranchComposer, type BranchDraft, type ExportState } from './BranchComposer';
import {
  effectiveGeometry,
  expansionCollisions,
  fromStored,
  geometryDelta,
  restoreStoredSize,
  type CardGeometry,
} from './cardGeometry';
import { isDraft, nodeRunId } from './pageContract';
import { BranchReader } from './BranchReader';
import { KeystoneCanvas, type KeystoneFlowInstance } from './KeystoneCanvas';
import { KeystoneUnavailable, unavailableMessage } from './KeystoneUnavailable';
import { NodeInspector, type EvidenceState } from './NodeInspector';
import type { BranchGateKind } from './BranchActions';
import { RunActivity, type FollowStatus } from './RunActivity';
import { isPlainClick, type RunLinkTarget } from './runLink';
import { appendStatus, EMPTY_LOG, type RunLog } from './runProgress';
import { statusLabel } from './StatusBadge';
import './keystone.css';

export type KeystoneView = 'canvas' | 'reader';

/**
 * Explicit run controls supplied by the full page. When present, new questions are
 * saved as drafts and run only when the user presses Run; branching depends on
 * storage and role, not on whether runs are available.
 */
export interface WorkspaceRuns {
  /** Why runs cannot start right now, or null. Reported independently of storage. */
  unavailable: string | null;
  start(
    nodeId: string,
    nodeVersion: number,
    expectedRevision: number,
  ): Promise<TransportResult<{ runId: string }>>;
  cancel(runId: string): Promise<TransportResult<{ status: NodeStatus }>>;
  /** Begins reading a run's events into `events`. */
  follow(runId: string): void;
  /** Problems following a run's live events, keyed by run ID. */
  streamNotes?: Readonly<Record<string, string>>;
  /** Whether each followed run's events are being read, keyed by run ID. */
  followStates?: Readonly<Record<string, FollowStatus>>;
}

/**
 * Routed deep links. `target` is what the URL names; `href` builds a shareable URL;
 * `onSelect` reports the selection so the URL can follow it (without a new history entry).
 */
export interface WorkspaceRunLinks {
  target: RunLinkTarget;
  href(target: RunLinkTarget): string;
  onSelect(target: RunLinkTarget): void;
}

function linkKey(target: RunLinkTarget) {
  return `${target.nodeId ?? ''}\u0000${target.runId ?? ''}`;
}

/** The node a link names: by node ID, else the node whose current run it is. */
function resolveLink(graph: InvestigationGraph, target: RunLinkTarget): GraphNode | null {
  return (
    (target.nodeId ? graph.nodes.find((node) => node.id === target.nodeId) : undefined) ??
    (target.runId ? graph.nodes.find((node) => nodeRunId(node) === target.runId) : undefined) ??
    null
  );
}

const RETRYABLE: readonly NodeStatus[] = ['failed', 'cancelled', 'interrupted', 'partial'];
const BRANCH_OPEN = { blocked: null, kind: 'waiting', next: null } as const;

export interface KeystoneWorkspaceProps {
  transport: KeystoneTransport;
  investigationId: string;
  /** Run event frames; omit when no run can be observed. */
  events?: RunEventSource;
  isAdmin?: boolean;
  /** Datasets offered when changing scope. The server re-authorizes every request. */
  availableDatasets?: string[];
  initialView?: KeystoneView;
  initialSelectedId?: string;
  createIdempotencyKey?: () => string;
  onCanvasInit?: (instance: KeystoneFlowInstance) => void;
  runs?: WorkspaceRuns;
  /** Deep links to a question and its run; omitted where the page is not routed. */
  runLinks?: WorkspaceRunLinks;
  /** Shown under an unavailable or failed load, such as a way back to the classic UI. */
  loadFallback?: ReactNode;
}

type Load =
  | { state: 'loading' }
  | { state: 'unavailable'; reason: UnavailableReason }
  | { state: 'error'; message: string }
  | { state: 'ready'; capabilities: KeystoneCapabilities };

type LayoutStatus =
  | { state: 'saved' }
  | { state: 'unsaved' }
  | { state: 'saving' }
  | { state: 'conflict' }
  | { state: 'error'; message: string };

/**
 * An Auto format result the user is reviewing. Nothing in it is persisted until
 * Save layout; Undo layout restores `baseline` and the edits that were waiting to save.
 */
interface FormatPreview {
  baseline: Record<string, CardGeometry>;
  pending: Record<string, CardGeometry>;
  status: LayoutStatus;
}

interface Composer {
  intent: 'follow_up' | 'explore';
  parentId: string;
  exported: ExportState;
  idempotencyKey: string;
  submitting: boolean;
  submitError: string | null;
  returnFocus: HTMLElement | null;
}

const NARROW = '(max-width: 760px)';
const SAVE_DELAY_MS = 300;

function prefersReducedMotion() {
  return (
    typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  );
}

function defaultKey() {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `ks-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function failureMessage(failure: TransportFailure, isAdmin: boolean) {
  switch (failure.kind) {
    case 'gated':
      return unavailableMessage(failure.reason, isAdmin);
    case 'conflict':
      return 'This investigation changed since it was loaded. Reload it to continue.';
    case 'denied':
      return 'You no longer have permission for this. Sign in again or ask an administrator.';
    case 'not_found':
      return 'This investigation is unavailable.';
    default:
      return failure.message;
  }
}

export function KeystoneWorkspace({
  transport,
  investigationId,
  events,
  isAdmin = false,
  availableDatasets = [],
  initialView,
  initialSelectedId,
  createIdempotencyKey = defaultKey,
  onCanvasInit,
  runs,
  runLinks,
  loadFallback,
}: KeystoneWorkspaceProps) {
  const [narrow, setNarrow] = useState(
    () => typeof window !== 'undefined' && !!window.matchMedia?.(NARROW).matches,
  );
  useEffect(() => {
    const media = window.matchMedia(NARROW);
    const update = () => setNarrow(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [graph, setGraph] = useState<InvestigationGraph | null>(null);
  const [geometry, setGeometry] = useState<Record<string, CardGeometry>>({});
  const [layoutRevision, setLayoutRevision] = useState<number | null>(null);
  const [layoutStatus, setLayoutStatus] = useState<LayoutStatus>({ state: 'saved' });
  const [undo, setUndo] = useState<Record<string, CardGeometry> | null>(null);
  const [preview, setPreviewState] = useState<FormatPreview | null>(null);
  const [pinnedConflicts, setPinnedConflicts] = useState<string[]>([]);
  const [formatError, setFormatError] = useState<string | null>(null);
  const [expandNote, setExpandNote] = useState<{ id: string; count: number } | null>(null);
  const [runIds, setRunIds] = useState<Record<string, string>>({});
  const [runAction, setRunAction] = useState<{ nodeId: string; kind: 'start' | 'cancel' } | null>(
    null,
  );
  const [runErrors, setRunErrors] = useState<Record<string, string>>({});
  const [selectedId, setSelectedId] = useState<string | null>(initialSelectedId ?? null);
  const [view, setView] = useState<KeystoneView>(
    () =>
      initialView ??
      (typeof window !== 'undefined' && window.matchMedia?.(NARROW).matches ? 'reader' : 'canvas'),
  );
  const [evidence, setEvidence] = useState<Record<string, EvidenceState>>({});
  const [composer, setComposer] = useState<Composer | null>(null);
  const composerRef = useRef(composer);
  composerRef.current = composer;
  const [notice, setNotice] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [stream, setStream] = useState({ applied: 0, duplicates: 0, gaps: 0, invalid: 0 });
  // What each run's own events reported, for its progress steps.
  const [runLogs, setRunLogs] = useState<Record<string, RunLog>>({});
  // A link named a run that is no longer its question's current run.
  const [staleLink, setStaleLink] = useState<{ nodeId: string; runId: string } | null>(null);
  // Scroll (and optionally focus) the run activity once the named question is shown.
  const [activityRequest, setActivityRequest] = useState<{ nodeId: string; focus: boolean } | null>(
    null,
  );
  const [viewHint, setViewHint] = useState<string | null>(null);
  const activityRef = useRef<HTMLElement>(null);
  const linkTarget = runLinks?.target ?? null;
  const linkTargetRef = useRef(linkTarget);
  linkTargetRef.current = linkTarget;
  // The link most recently resolved or written, so the URL echo of a selection is ignored.
  const appliedLink = useRef<string | null>(null);
  const emittedLink = useRef<string | null>(null);

  const flow = useRef<KeystoneFlowInstance | null>(null);
  const pending = useRef<Record<string, CardGeometry>>({});
  const saving = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const revisionRef = useRef<number | null>(null);
  revisionRef.current = layoutRevision;
  const geometryRef = useRef(geometry);
  geometryRef.current = geometry;
  const previewRef = useRef<FormatPreview | null>(null);
  const setPreview = useCallback((next: FormatPreview | null) => {
    previewRef.current = next;
    setPreviewState(next);
  }, []);
  const sequencers = useRef(new Map<string, RunEventSequencer>());
  const seenEvidence = useRef(new Map<string, Set<string>>());
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;
  const composerToken = useRef(0);
  const inspectorHeading = useRef<HTMLDivElement>(null);
  const formatButton = useRef<HTMLButtonElement>(null);
  const saveButton = useRef<HTMLButtonElement>(null);

  // The latest graph, updated synchronously so consecutive stream events compose.
  const graphRef = useRef<InvestigationGraph | null>(null);
  const updateGraph = useCallback((next: InvestigationGraph) => {
    graphRef.current = next;
    setGraph(next);
  }, []);

  const capabilities = load.state === 'ready' ? load.capabilities : null;
  const editable =
    !narrow && !!capabilities?.actions.editLayout && layoutStatus.state !== 'conflict';
  const editableRef = useRef(editable);
  editableRef.current = editable;

  const applyLayout = useCallback((next: InvestigationGraph, saved: CanvasLayout | null) => {
    setGeometry(fromStored(resolveLayout(next, saved)));
    setLayoutRevision(saved?.layoutRevision ?? 0);
    pending.current = {};
  }, []);

  // Initial load: capabilities, then the semantic graph, then its separate layout.
  useEffect(() => {
    let live = true;
    (async () => {
      const caps = await transport.capabilities();
      if (!live) return;
      if (!caps.ok) {
        setLoad(
          caps.kind === 'gated'
            ? { state: 'unavailable', reason: caps.reason }
            : caps.kind === 'denied' || caps.kind === 'not_found'
              ? { state: 'unavailable', reason: 'permission_denied' }
              : { state: 'error', message: failureMessage(caps, isAdmin) },
        );
        return;
      }
      if (!caps.value.actions.read) {
        setLoad({ state: 'unavailable', reason: 'permission_denied' });
        return;
      }
      const loaded = await transport.graph(investigationId);
      if (!live) return;
      if (!loaded.ok) {
        setLoad(
          loaded.kind === 'denied' || loaded.kind === 'not_found'
            ? { state: 'unavailable', reason: 'permission_denied' }
            : { state: 'error', message: failureMessage(loaded, isAdmin) },
        );
        return;
      }
      const layout = await transport.layout(
        investigationId,
        new Set(loaded.value.nodes.map((node) => node.id)),
      );
      if (!live) return;
      updateGraph(loaded.value);
      applyLayout(loaded.value, layout.ok ? layout.value : null);
      if (!layout.ok && layout.kind !== 'not_found')
        setLayoutStatus({
          state: 'error',
          message: 'Saved positions could not be loaded; showing the default layout.',
        });
      // A deep link wins over the default; a link to a missing question falls back to the root.
      const link = linkTargetRef.current;
      const linked = link ? resolveLink(loaded.value, link) : null;
      if (link) appliedLink.current = linkKey(link);
      if ((link?.nodeId || link?.runId) && !linked)
        setViewHint(
          'The linked question is not in this investigation. Showing the first question.',
        );
      if (linked) {
        setSelectedId(linked.id);
        if (link?.runId) {
          if (nodeRunId(linked) !== link.runId)
            setStaleLink({ nodeId: linked.id, runId: link.runId });
          setActivityRequest({ nodeId: linked.id, focus: false });
        }
      } else
        setSelectedId((current) =>
          current && loaded.value.nodes.some((node) => node.id === current)
            ? current
            : loaded.value.rootNodeId,
        );
      setLoad({ state: 'ready', capabilities: caps.value });
    })();
    return () => {
      live = false;
    };
  }, [transport, investigationId, isAdmin, applyLayout, updateGraph]);

  const selected = graph?.nodes.find((node) => node.id === selectedId) ?? null;

  // Selection changes abort stored-artifact reads; late responses cannot repaint another node.
  const evidenceRef = useRef(evidence);
  const evidenceVersions = useRef(new Map<string, string>());
  const selectedEvidenceVersion = `${selected?.runId ?? 'none'}:${selected && isTerminal(selected.status) ? 'terminal' : 'active'}`;
  evidenceRef.current = evidence;
  useEffect(() => {
    if (
      !selectedId ||
      (evidenceRef.current[selectedId]?.state === 'ready' &&
        evidenceVersions.current.get(selectedId) === selectedEvidenceVersion)
    )
      return;
    evidenceVersions.current.set(selectedId, selectedEvidenceVersion);
    const controller = new AbortController();
    setEvidence((current) => ({ ...current, [selectedId]: { state: 'loading' } }));
    transport.evidence(investigationId, selectedId, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      setEvidence((current) => ({
        ...current,
        [selectedId]: result.ok
          ? { state: 'ready', items: result.value }
          : { state: 'error', message: failureMessage(result, isAdmin) },
      }));
      if (result.ok)
        seenEvidence.current.set(selectedId, new Set(result.value.map((item) => item.id)));
    });
    return () => controller.abort();
  }, [selectedId, selectedEvidenceVersion, transport, investigationId, isAdmin]);

  // Layout persistence: serialized, debounced PATCHes under the layout revision only.
  // A format preview holds every write until the user saves it.
  const flush = useCallback(async () => {
    if (saving.current || previewRef.current || revisionRef.current === null) return;
    const nodes = pending.current;
    if (!Object.keys(nodes).length) return;
    pending.current = {};
    saving.current = true;
    setLayoutStatus({ state: 'saving' });
    const result = await transport.patchLayout(investigationId, {
      expectedLayoutRevision: revisionRef.current,
      nodes,
    });
    saving.current = false;
    if (result.ok) {
      revisionRef.current = result.value.layoutRevision;
      setLayoutRevision(result.value.layoutRevision);
      if (Object.keys(pending.current).length) void flush();
      else setLayoutStatus({ state: 'saved' });
    } else if (result.kind === 'conflict') {
      setLayoutStatus({ state: 'conflict' });
    } else {
      pending.current = { ...nodes, ...pending.current };
      setLayoutStatus({ state: 'error', message: failureMessage(result, isAdmin) });
    }
  }, [transport, investigationId, isAdmin]);

  const onGeometryChange = useCallback(
    (changes: Record<string, CardGeometry>) => {
      setGeometry((current) => ({ ...current, ...changes }));
      setPinnedConflicts([]);
      setFormatError(null);
      setExpandNote(null);
      if (previewRef.current) return;
      setUndo(null);
      pending.current = { ...pending.current, ...changes };
      setLayoutStatus({ state: 'unsaved' });
      clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => void flush(), SAVE_DELAY_MS);
    },
    [flush],
  );

  useEffect(() => () => clearTimeout(saveTimer.current), []);

  const reloadLayout = useCallback(async () => {
    if (!graph) return;
    const layout = await transport.layout(
      investigationId,
      new Set(graph.nodes.map((node) => node.id)),
    );
    if (layout.ok) {
      applyLayout(graph, layout.value);
      setPreview(null);
      setPinnedConflicts([]);
      setFormatError(null);
      setUndo(null);
      setLayoutStatus({ state: 'saved' });
    } else setLayoutStatus({ state: 'error', message: failureMessage(layout, isAdmin) });
  }, [graph, transport, investigationId, applyLayout, isAdmin, setPreview]);

  // Auto format: manual only. Repeating it keeps the first baseline so Undo returns to
  // the geometry from before any formatting, and a waiting autosave never sends the preview.
  const format = useCallback(() => {
    if (!graph || saving.current) return;
    let result;
    try {
      // Collapsed cards are placed at the height they are drawn; their stored
      // expanded size and collapsed flag are carried through unchanged.
      const formatted = formatLayout(graph, effectiveGeometry(geometryRef.current));
      result = {
        nodes: restoreStoredSize(formatted.nodes, geometryRef.current),
        pinnedConflicts: formatted.pinnedConflicts,
      };
    } catch (error) {
      setFormatError(
        error instanceof FormatLayoutError
          ? 'Formatting cannot fit within canvas limits. Move pinned cards inward or use smaller cards.'
          : 'The layout could not be formatted. Your positions have been kept.',
      );
      return;
    }
    clearTimeout(saveTimer.current);
    setFormatError(null);
    setExpandNote(null);
    if (!previewRef.current)
      setPreview({
        baseline: geometryRef.current,
        pending: pending.current,
        status: layoutStatus,
      });
    setGeometry((current) => ({ ...current, ...result.nodes }));
    setPinnedConflicts(result.pinnedConflicts);
    setLayoutStatus({ state: 'unsaved' });
  }, [graph, layoutStatus, setPreview]);

  const undoLayout = useCallback(() => {
    if (saving.current) return;
    const current = previewRef.current;
    if (!current) {
      if (!undo) return;
      setUndo(null);
      onGeometryChange(undo);
      return;
    }
    setPreview(null);
    setPinnedConflicts([]);
    setFormatError(null);
    setGeometry(current.baseline);
    pending.current = current.pending;
    setLayoutStatus(current.status);
    if (Object.keys(current.pending).length && current.status.state === 'unsaved')
      saveTimer.current = setTimeout(() => void flush(), SAVE_DELAY_MS);
  }, [undo, onGeometryChange, setPreview, flush]);

  // One PATCH carries the formatted cards and any edits waiting from before formatting.
  const savePreview = useCallback(async () => {
    const current = previewRef.current;
    if (!current || saving.current || revisionRef.current === null) return;
    const restoreFocus = document.activeElement === saveButton.current;
    const focusAfterSave = () =>
      requestAnimationFrame(() => {
        if (restoreFocus && document.activeElement === document.body) formatButton.current?.focus();
      });
    const shown = geometryRef.current;
    const ids = new Set([
      ...Object.keys(current.pending),
      ...Object.keys(geometryDelta(current.baseline, shown)),
    ]);
    const nodes: Record<string, CardGeometry> = {};
    for (const id of ids) if (shown[id]) nodes[id] = shown[id];
    if (!Object.keys(nodes).length) {
      setPreview(null);
      setLayoutStatus({ state: 'saved' });
      focusAfterSave();
      return;
    }
    saving.current = true;
    setLayoutStatus({ state: 'saving' });
    const result = await transport.patchLayout(investigationId, {
      expectedLayoutRevision: revisionRef.current,
      nodes,
    });
    saving.current = false;
    if (result.ok) {
      revisionRef.current = result.value.layoutRevision;
      setLayoutRevision(result.value.layoutRevision);
      pending.current = {};
      setPreview(null);
      setUndo(current.baseline);
      setLayoutStatus({ state: 'saved' });
      focusAfterSave();
    } else if (result.kind === 'conflict') {
      setLayoutStatus({ state: 'conflict' });
    } else {
      setLayoutStatus({ state: 'error', message: failureMessage(result, isAdmin) });
    }
  }, [transport, investigationId, isAdmin, setPreview]);

  // Collapse is layout state: it is saved with the layout revision like a move, and
  // during a format preview it waits for Save layout. Expanding never reformats; a
  // collision is reported so the user can choose Auto format.
  const toggleCollapsed = useCallback(
    (id: string) => {
      const current = geometryRef.current[id];
      // A reviewed layout being written is held still, like a drag, so nothing is lost.
      if (!current || (saving.current && previewRef.current)) return;
      const next: CardGeometry = { ...current, collapsed: !current.collapsed };
      // Without layout permission (or after a conflict) collapse is local to this view.
      if (editableRef.current) onGeometryChange({ [id]: next });
      else setGeometry((existing) => ({ ...existing, [id]: next }));
      if (!next.collapsed) {
        const count = expansionCollisions(id, { ...geometryRef.current, [id]: next }).length;
        setExpandNote(count ? { id, count } : null);
      } else setExpandNote(null);
    },
    [onGeometryChange],
  );

  // Run events: strictly sequenced per run, duplicates dropped, gaps replayed.
  const hasRuns = !!runs;
  useEffect(() => {
    if (!events) return;
    let live = true;
    const unsubscribe = events.subscribe((runId, frame) => {
      let sequencer = sequencers.current.get(runId);
      if (!sequencer) {
        sequencer = new RunEventSequencer(runId);
        sequencers.current.set(runId, sequencer);
      }
      const result = sequencer.accept(frame);
      if (result.type === 'duplicate') {
        setStream((current) => ({ ...current, duplicates: current.duplicates + 1 }));
        return;
      }
      if (result.type === 'invalid') {
        setStream((current) => ({ ...current, invalid: current.invalid + 1 }));
        return;
      }
      if (result.type === 'gap') {
        setStream((current) => ({ ...current, gaps: current.gaps + 1 }));
        sequencer.resync(sequencer.resumeAfter);
        events.replay(runId, sequencer.resumeAfter);
        return;
      }
      const event = result.event;
      setStream((current) => ({ ...current, applied: current.applied + 1 }));
      if (event.kind === 'status' || event.kind === 'terminal')
        setRunLogs((logs) => {
          const before = logs[runId] ?? EMPTY_LOG;
          const appended = appendStatus(before, event.status);
          const after =
            event.kind === 'terminal' ? { ...appended, reason: event.reason } : appended;
          return after === before ? logs : { ...logs, [runId]: after };
        });
      const seen = seenEvidence.current.get(event.nodeId) ?? new Set<string>();
      const current = graphRef.current;
      const before = current?.nodes.find((node) => node.id === event.nodeId);
      if (!current || !before || (before.runId && before.runId !== runId)) return;
      const after = applyRunEvent(before, event, seen);
      if (after !== before) {
        updateGraph({
          ...current,
          nodes: current.nodes.map((node) => (node.id === after.id ? after : node)),
        });
        if (!isTerminal(before.status) && isTerminal(after.status)) {
          setAnnouncement(`${after.title}: ${statusLabel(after.status)}.`);
          if (after.id !== selectedRef.current) setNotice(after.id);
        }
      }
      if (hasRuns && event.kind === 'terminal') {
        void transport.graph(investigationId).then((snapshot) => {
          if (!live || !snapshot.ok) return;
          const latest = graphRef.current;
          const completed = snapshot.value.nodes.find(
            (node) => node.id === event.nodeId && node.runId === runId,
          );
          if (!latest || !completed) return;
          updateGraph({
            ...latest,
            semanticRevision: Math.max(latest.semanticRevision, snapshot.value.semanticRevision),
            nodes: latest.nodes.map((node) =>
              node.id === completed.id && node.runId === runId ? completed : node,
            ),
          });
        });
      }
      if (event.kind === 'evidence' && !seen.has(event.evidence.id)) {
        seen.add(event.evidence.id);
        seenEvidence.current.set(event.nodeId, seen);
        setEvidence((current) => {
          const entry = current[event.nodeId];
          return entry?.state === 'ready'
            ? {
                ...current,
                [event.nodeId]: { state: 'ready', items: [...entry.items, event.evidence] },
              }
            : current;
        });
      }
    });
    return () => {
      live = false;
      unsubscribe();
    };
  }, [events, updateGraph, hasRuns, transport, investigationId]);

  // A lost stream is not the run's outcome. Re-read its authorized state once,
  // without changing positions or selecting another question. Explicit reconnect
  // resumes events; a late snapshot must never overwrite a newer run or outcome.
  const followStates = runs?.followStates;
  useEffect(() => {
    let live = true;
    const failedRuns = Object.entries(followStates ?? {})
      .filter(([, state]) => state === 'unavailable')
      .map(([runId]) => runId);
    if (!failedRuns.length) return;
    void transport.graph(investigationId).then((snapshot) => {
      if (!live) return;
      if (!snapshot.ok) {
        if (snapshot.kind === 'denied' || snapshot.kind === 'not_found')
          setLoad({ state: 'unavailable', reason: 'permission_denied' });
        return;
      }
      const current = graphRef.current;
      if (!current) return;
      const recovered = new Map(
        snapshot.value.nodes
          .filter((node) => node.runId && failedRuns.includes(node.runId))
          .map((node) => [node.id, node]),
      );
      updateGraph({
        ...current,
        semanticRevision: Math.max(current.semanticRevision, snapshot.value.semanticRevision),
        nodes: current.nodes.map((node) => {
          const latest = recovered.get(node.id);
          return latest &&
            latest.runId === node.runId &&
            !(isTerminal(node.status) && !isTerminal(latest.status))
            ? latest
            : node;
        }),
      });
    });
    return () => {
      live = false;
    };
  }, [followStates, transport, investigationId, updateGraph]);

  const select = useCallback((id: string) => {
    setSelectedId(id);
    setNotice((current) => (current === id ? null : current));
    setStaleLink((current) => (current?.nodeId === id ? current : null));
    setViewHint(null);
  }, []);

  const reduced = prefersReducedMotion();
  const reveal = useCallback(
    (id: string) => {
      const instance = flow.current;
      if (!instance || view !== 'canvas') return;
      instance.fitView({
        nodes: [{ id }],
        maxZoom: Math.max(instance.getZoom(), 0.8),
        duration: reduced ? 0 : 200,
      });
    },
    [view, reduced],
  );

  // Branching is from a completed direct parent only: the child inherits that finished
  // answer and nothing else. A role without the action is read-only; any other block
  // clears once the question is answered.
  const branchGate = useMemo((): {
    blocked: string | null;
    kind: BranchGateKind;
    next: string | null;
  } => {
    const waiting = (blocked: string, next: string | null = null) =>
      ({ blocked, kind: 'waiting', next }) as const;
    if (!capabilities || !selected) return waiting('Loading.');
    if (!capabilities.actions.branch)
      return {
        blocked: 'Your role cannot add questions to this investigation.',
        kind: 'read_only',
        next: 'You can read every question, answer and source. Ask an administrator for access to add questions.',
      };
    const notCompleted = `Branch from a completed answer. This question is ${statusLabel(selected.status).toLowerCase()}.`;
    const next = isDraft(selected)
      ? 'Run this question first. Once it is answered, Follow up and Explore are available here.'
      : ACTIVE_STATUSES.includes(selected.status)
        ? 'Available when this run finishes with an answer. Its progress is shown above.'
        : RETRYABLE.includes(selected.status)
          ? 'Only a completed answer is passed on to a new question. Retry this question, or branch from another answered one.'
          : null;
    // Saving a draft needs storage and role only; running it is gated separately.
    if (runs) return selected.status !== 'completed' ? waiting(notCompleted, next) : BRANCH_OPEN;
    if (!capabilities.actions.run)
      return {
        blocked: 'Your role cannot run questions in this investigation.',
        kind: 'read_only',
        next: null,
      };
    if (capabilities.generative.state !== 'ready')
      return waiting(
        unavailableMessage(capabilities.generative.reason ?? 'provider_unconfigured', isAdmin),
      );
    if (capabilities.tools.state !== 'ready')
      return waiting(unavailableMessage(capabilities.tools.reason ?? 'tools_unavailable', isAdmin));
    if (selected.status !== 'completed') return waiting(notCompleted, next);
    return BRANCH_OPEN;
  }, [capabilities, selected, isAdmin, runs]);
  const branchBlocked = branchGate.blocked;

  const runGate = useMemo(() => {
    if (!capabilities) return null;
    if (runs) return runs.unavailable;
    if (capabilities.generative.state !== 'ready')
      return unavailableMessage(capabilities.generative.reason ?? 'provider_unconfigured', isAdmin);
    if (capabilities.tools.state !== 'ready')
      return unavailableMessage(capabilities.tools.reason ?? 'tools_unavailable', isAdmin);
    return null;
  }, [capabilities, isAdmin, runs]);

  // Reopened investigations resume following runs that are still active.
  const followed = useRef(new Set<string>());
  useEffect(() => {
    if (!runs || !graph) return;
    for (const node of graph.nodes) {
      const runId = runIds[node.id] ?? nodeRunId(node);
      if (runId && ACTIVE_STATUSES.includes(node.status) && !followed.current.has(runId)) {
        followed.current.add(runId);
        runs.follow(runId);
      }
    }
  }, [runs, graph, runIds]);

  /** Starts reading a run's events, or resumes after the last one applied. */
  const reconnect = useCallback(
    (runId: string) => {
      if (!runs) return;
      if (!followed.current.has(runId)) {
        followed.current.add(runId);
        runs.follow(runId);
      } else events?.replay(runId, sequencers.current.get(runId)?.resumeAfter ?? 0);
    },
    [runs, events],
  );

  const ready = load.state === 'ready';
  const selectedRunId = selected ? (runIds[selected.id] ?? nodeRunId(selected)) : null;

  // Back/forward or a link opened in place: select what the URL now names.
  const targetNode = linkTarget?.nodeId ?? null;
  const targetRun = linkTarget?.runId ?? null;
  useEffect(() => {
    const current = graphRef.current;
    if (!ready || !current || (!targetNode && !targetRun)) return;
    const target = { nodeId: targetNode, runId: targetRun };
    const key = linkKey(target);
    if (key === appliedLink.current) return;
    appliedLink.current = key;
    const linked = resolveLink(current, target);
    if (!linked) {
      setViewHint('The linked question is not in this investigation.');
      return;
    }
    setSelectedId(linked.id);
    setNotice((existing) => (existing === linked.id ? null : existing));
    setStaleLink(
      targetRun && nodeRunId(linked) !== targetRun && runIds[linked.id] !== targetRun
        ? { nodeId: linked.id, runId: targetRun }
        : null,
    );
    if (targetRun) setActivityRequest({ nodeId: linked.id, focus: false });
  }, [ready, targetNode, targetRun, runIds]);

  // The URL follows the selection and its current run.
  const onLinkSelect = runLinks?.onSelect;
  useEffect(() => {
    if (!ready || !selectedId || !onLinkSelect) return;
    const target = { nodeId: selectedId, runId: selectedRunId };
    const key = linkKey(target);
    if (key === emittedLink.current) return;
    emittedLink.current = key;
    appliedLink.current = key;
    onLinkSelect(target);
  }, [ready, selectedId, selectedRunId, onLinkSelect]);

  // A finished run opened by link replays its recorded events once, so its steps show.
  const selectedStatus = selected?.status;
  useEffect(() => {
    if (
      !activityRequest ||
      !runs ||
      !selectedRunId ||
      activityRequest.nodeId !== selectedId ||
      !selectedStatus ||
      !isTerminal(selectedStatus) ||
      followed.current.has(selectedRunId)
    )
      return;
    reconnect(selectedRunId);
  }, [activityRequest, runs, selectedRunId, selectedId, selectedStatus, reconnect]);

  useEffect(() => {
    if (!activityRequest || activityRequest.nodeId !== selectedId) return;
    const target = activityRef.current;
    if (!target) {
      if (!selectedRunId) setActivityRequest(null);
      return;
    }
    const behavior = prefersReducedMotion() ? 'auto' : 'smooth';
    const frame = requestAnimationFrame(() => {
      target.scrollIntoView?.({ block: 'nearest', behavior });
      if (activityRequest.focus) target.focus({ preventScroll: true });
      setActivityRequest(null);
    });
    return () => cancelAnimationFrame(frame);
  }, [activityRequest, selectedId, selectedRunId]);

  /** Selects a question and brings its run activity into view. */
  const viewRun = useCallback(
    (nodeId: string, { reveal: pan = false } = {}) => {
      if (composerRef.current) {
        setViewHint('Finish or cancel the new question to view this run.');
        return;
      }
      select(nodeId);
      setActivityRequest({ nodeId, focus: true });
      if (pan) reveal(nodeId);
    },
    [select, reveal],
  );

  const setNodeStatus = useCallback(
    (id: string, status: NodeStatus) => {
      const current = graphRef.current;
      if (!current) return;
      updateGraph({
        ...current,
        nodes: current.nodes.map((node) => (node.id === id ? { ...node, status } : node)),
      });
    },
    [updateGraph],
  );

  const startRun = useCallback(async () => {
    if (!runs || !selected || runAction) return;
    const node = selected;
    setRunAction({ nodeId: node.id, kind: 'start' });
    setRunErrors(({ [node.id]: _cleared, ...rest }) => rest);
    const result = await runs.start(node.id, node.version, graphRef.current?.semanticRevision ?? 0);
    setRunAction(null);
    if (!result.ok) {
      setRunErrors((current) => ({ ...current, [node.id]: failureMessage(result, isAdmin) }));
      return;
    }
    const runId = result.value.runId;
    setRunIds((current) => ({ ...current, [node.id]: runId }));
    setStaleLink(null);
    // The server accepted the run: it is queued until its own events say otherwise.
    const latest = graphRef.current?.nodes.find((item) => item.id === node.id);
    if (latest) {
      const current = graphRef.current!;
      updateGraph({
        ...current,
        nodes: current.nodes.map((item) =>
          item.id === node.id
            ? { ...item, runId, status: 'queued', answer: null, evidenceCount: 0 }
            : item,
        ),
      });
      seenEvidence.current.delete(node.id);
      setEvidence((current) => ({ ...current, [node.id]: { state: 'ready', items: [] } }));
    }
    void transport.graph(investigationId).then((snapshot) => {
      const current = graphRef.current;
      if (!snapshot.ok || !current) return;
      const started = snapshot.value.nodes.find(
        (item) => item.id === node.id && item.runId === runId,
      );
      updateGraph({
        ...current,
        semanticRevision: Math.max(current.semanticRevision, snapshot.value.semanticRevision),
        nodes: current.nodes.map((item) =>
          started && item.id === node.id && item.runId === runId
            ? { ...item, contextHash: started.contextHash }
            : item,
        ),
      });
    });
    followed.current.add(runId);
    runs.follow(runId);
    setAnnouncement(`${node.title}: run accepted and queued.`);
  }, [runs, selected, runAction, isAdmin, updateGraph, transport, investigationId]);

  const cancelRun = useCallback(async () => {
    if (!runs || !selected || runAction) return;
    const node = selected;
    const runId = runIds[node.id] ?? nodeRunId(node);
    if (!runId) return;
    setRunAction({ nodeId: node.id, kind: 'cancel' });
    setRunErrors(({ [node.id]: _cleared, ...rest }) => rest);
    const result = await runs.cancel(runId);
    setRunAction(null);
    if (!result.ok) {
      setRunErrors((current) => ({ ...current, [node.id]: failureMessage(result, isAdmin) }));
      return;
    }
    const latest = graphRef.current?.nodes.find((item) => item.id === node.id);
    if (latest && !isTerminal(latest.status) && isTerminal(result.value.status))
      setNodeStatus(node.id, result.value.status);
    setAnnouncement(
      isTerminal(result.value.status)
        ? `${node.title}: ${statusLabel(result.value.status)}.`
        : `${node.title}: cancellation requested.`,
    );
  }, [runs, selected, runAction, runIds, isAdmin, setNodeStatus]);

  const openComposer = useCallback(
    (intent: 'follow_up' | 'explore') => {
      if (!selected) return;
      const token = ++composerToken.current;
      const parentId = selected.id;
      setComposer({
        intent,
        parentId,
        exported: { state: 'loading' },
        idempotencyKey: createIdempotencyKey(),
        submitting: false,
        submitError: null,
        returnFocus: document.activeElement instanceof HTMLElement ? document.activeElement : null,
      });
      transport.parentExport(investigationId, parentId).then(async (result) => {
        const exported: ExportState = result.ok
          ? { state: 'ready', pinned: await pinParentExport(result.value) }
          : { state: 'error', message: failureMessage(result, isAdmin) };
        if (exported.state === 'ready' && exported.pinned.value.parentNodeId !== parentId)
          return setComposer((current) =>
            composerToken.current === token && current
              ? {
                  ...current,
                  exported: {
                    state: 'error',
                    message: 'The server returned context for a different question.',
                  },
                }
              : current,
          );
        setComposer((current) =>
          composerToken.current === token && current ? { ...current, exported } : current,
        );
      });
    },
    [selected, createIdempotencyKey, transport, investigationId, isAdmin],
  );

  const closeComposer = useCallback(() => {
    const focus = composer?.returnFocus;
    const action =
      focus?.dataset.testid === 'ks-quick-follow-up'
        ? 'ks-quick-follow-up'
        : composer?.intent === 'explore'
          ? 'ks-explore'
          : 'ks-follow-up';
    composerToken.current++;
    setComposer(null);
    setViewHint(null);
    requestAnimationFrame(() => {
      if (focus?.isConnected) focus.focus();
      else {
        const restored = inspectorHeading.current?.querySelector<HTMLButtonElement>(
          `[data-testid="${action}"]`,
        );
        (restored ?? inspectorHeading.current)?.focus();
      }
    });
  }, [composer]);

  const submit = useCallback(
    async (draft: BranchDraft) => {
      if (!composer || !graph) return;
      const token = composerToken.current;
      setComposer((current) => current && { ...current, submitting: true, submitError: null });
      const result = await transport.createNode(investigationId, {
        ...draft,
        idempotencyKey: composer.idempotencyKey,
        expectedSemanticRevision: graph.semanticRevision,
      });
      if (composerToken.current !== token) return;
      if (!result.ok) {
        setComposer(
          (current) =>
            current && {
              ...current,
              submitting: false,
              submitError: failureMessage(result, isAdmin),
            },
        );
        return;
      }
      const created = result.value.node;
      const current = graphRef.current;
      if (current && !current.nodes.some((node) => node.id === created.id)) {
        const next = {
          ...current,
          semanticRevision: result.value.semanticRevision,
          nodes: [...current.nodes, created],
        };
        updateGraph(next);
        const position = treeLayout(next)[created.id];
        setGeometry((existing) => ({ ...existing, [created.id]: position }));
        const reviewing = previewRef.current;
        if (reviewing)
          setPreview({
            ...reviewing,
            baseline: { ...reviewing.baseline, [created.id]: position },
          });
      }
      composerToken.current++;
      setComposer(null);
      setSelectedId(created.id);
      setAnnouncement(`Added question ${created.title}.`);
      requestAnimationFrame(() => {
        inspectorHeading.current?.focus();
        reveal(created.id);
      });
    },
    [composer, graph, transport, investigationId, isAdmin, reveal, updateGraph, setPreview],
  );

  function runControls(node: GraphNode) {
    const runId = runIds[node.id] ?? nodeRunId(node);
    const active = ACTIVE_STATUSES.includes(node.status);
    const retry = RETRYABLE.includes(node.status);
    const action = isDraft(node) || retry ? 'run' : active && runId ? 'cancel' : null;
    const blocked =
      action === 'run'
        ? !capabilities?.actions.run
          ? 'Your role cannot run questions in this investigation.'
          : (runs?.unavailable ?? null)
        : action === 'cancel' && !capabilities?.actions.run
          ? 'Your role cannot cancel runs in this investigation.'
          : null;
    return {
      action,
      retry,
      blocked,
      pending: runAction?.nodeId === node.id,
      error: runErrors[node.id] ?? null,
      // Live-stream problems are reported with the run's activity, beside its steps.
      streamNote: null,
      onRun: () => void startRun(),
      onCancel: () => void cancelRun(),
    } as const;
  }

  function runActivity(node: GraphNode) {
    const runId = runIds[node.id] ?? nodeRunId(node);
    if (!runs || !runId) return null;
    const target = { nodeId: node.id, runId };
    return (
      <RunActivity
        ref={activityRef}
        status={node.status}
        runId={runId}
        log={runLogs[runId] ?? EMPTY_LOG}
        follow={runs.followStates?.[runId] ?? null}
        streamNote={runs.streamNotes?.[runId] ?? null}
        href={runLinks ? runLinks.href(target) : null}
        onOpenLink={() => viewRun(node.id)}
        onReconnect={() => reconnect(runId)}
        onLoadHistory={() => reconnect(runId)}
        staleRunId={staleLink?.nodeId === node.id ? staleLink.runId : null}
      />
    );
  }

  if (load.state === 'loading')
    return (
      <div className="ks-workspace" data-testid="ks-workspace" data-state="loading">
        <Spinner label="Loading investigation" />
      </div>
    );
  if (load.state === 'unavailable')
    return (
      <div className="ks-workspace" data-testid="ks-workspace" data-state="unavailable">
        <KeystoneUnavailable reason={load.reason} isAdmin={isAdmin} />
        {loadFallback}
      </div>
    );
  if (load.state === 'error' || !graph)
    return (
      <div className="ks-workspace" data-testid="ks-workspace" data-state="error">
        <p className="ks-note" data-tone="danger" role="alert" data-testid="ks-load-error">
          {load.state === 'error' ? load.message : 'The investigation could not be loaded.'}
        </p>
        {loadFallback}
      </div>
    );

  const parent = selected ? neighbours(graph, selected.id).parent : null;
  const composerParent = composer
    ? graph.nodes.find((node) => node.id === composer.parentId)
    : null;
  const noticeNode = notice ? graph.nodes.find((node) => node.id === notice) : null;
  const activeNodes = graph.nodes.filter((node) => ACTIVE_STATUSES.includes(node.status));
  const layoutSaving = layoutStatus.state === 'saving';
  const reviewing = !!preview && layoutStatus.state === 'unsaved';
  // Cards stay still while a reviewed layout is being written, so nothing is lost mid-save.
  const canvasEditable = editable && !(preview && layoutSaving);
  const overlapNote =
    pinnedConflicts.length > 0
      ? `${pinnedConflicts.length} pinned cards overlap. Unpin them and format again.`
      : null;

  return (
    <div
      className="ks-workspace"
      data-testid="ks-workspace"
      data-state="ready"
      data-view={view}
      data-selected={selectedId ?? ''}
      data-semantic-revision={graph.semanticRevision}
      data-layout-revision={layoutRevision ?? ''}
      data-format-preview={preview ? 'true' : undefined}
    >
      <header className="ks-toolbar">
        <h1 className="ks-title">{graph.title}</h1>
        <div className="ks-segmented" role="group" aria-label="View">
          <button
            type="button"
            aria-pressed={view === 'canvas'}
            onClick={() => setView('canvas')}
            data-testid="ks-view-canvas"
          >
            Canvas
          </button>
          <button
            type="button"
            aria-pressed={view === 'reader'}
            onClick={() => setView('reader')}
            data-testid="ks-view-reader"
          >
            Branch reader
          </button>
        </div>
        {view === 'canvas' ? (
          <div className="ks-tools" role="group" aria-label="Canvas layout">
            <Button
              size="sm"
              disabled={!editable || layoutSaving}
              ref={formatButton}
              data-testid="ks-auto-layout"
              onClick={format}
            >
              Auto format
            </Button>
            <Button
              size="sm"
              disabled={!editable || layoutSaving || (!preview && !undo)}
              data-testid="ks-undo-layout"
              onClick={undoLayout}
            >
              Undo layout
            </Button>
            {preview ? (
              <Button
                size="sm"
                variant="primary"
                disabled={!editable || layoutSaving}
                ref={saveButton}
                data-testid="ks-save-layout"
                onClick={() => void savePreview()}
              >
                Save layout
              </Button>
            ) : null}
            <Button
              size="sm"
              disabled={!canvasEditable || !selected}
              data-testid="ks-reset-position"
              onClick={() => {
                if (!selected) return;
                const computed: CardGeometry = treeLayout(graph)[selected.id];
                const collapsed = geometry[selected.id]?.collapsed;
                onGeometryChange({
                  [selected.id]: collapsed === undefined ? computed : { ...computed, collapsed },
                });
              }}
            >
              Reset position
            </Button>
            <Button
              size="sm"
              disabled={!canvasEditable || !selected}
              aria-pressed={selected ? !!geometry[selected.id]?.pinned : false}
              data-testid="ks-pin"
              onClick={() => {
                if (!selected) return;
                const current = geometry[selected.id];
                onGeometryChange({ [selected.id]: { ...current, pinned: !current.pinned } });
              }}
            >
              {selected && geometry[selected.id]?.pinned ? 'Unpin card' : 'Pin card'}
            </Button>
            <Button
              size="sm"
              disabled={!selected}
              data-testid="ks-jump"
              onClick={() => selected && reveal(selected.id)}
            >
              Show selected
            </Button>
          </div>
        ) : null}
        <p
          className="ks-layout-status"
          data-testid="ks-layout-status"
          data-state={reviewing ? 'preview' : layoutStatus.state}
          aria-live="polite"
        >
          {narrow
            ? 'Canvas overview: pan and zoom. Use a larger screen to move cards.'
            : !capabilities?.actions.editLayout
              ? 'Card positions are read-only for your role.'
              : reviewing
                ? 'Formatted layout not saved. Review it, then save or undo.'
                : layoutStatus.state === 'saved'
                  ? 'Layout saved'
                  : layoutStatus.state === 'unsaved' || layoutStatus.state === 'saving'
                    ? 'Saving layout'
                    : layoutStatus.state === 'conflict'
                      ? 'Layout changed elsewhere.'
                      : layoutStatus.message}
          {layoutStatus.state === 'error' && !preview && editable ? (
            <Button
              size="sm"
              variant="ghost"
              data-testid="ks-retry-layout"
              onClick={() => void flush()}
            >
              Retry save
            </Button>
          ) : null}
          {layoutStatus.state === 'conflict' || layoutStatus.state === 'error' ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void reloadLayout()}
              data-testid="ks-reload-layout"
            >
              Reload layout
            </Button>
          ) : null}
        </p>
        {formatError ? (
          <p className="ks-format-note" role="alert" data-testid="ks-format-error">
            {formatError}
          </p>
        ) : null}
        <p
          className={overlapNote && !narrow ? 'ks-format-note' : 'sr-only'}
          data-testid="ks-pinned-conflicts"
          data-count={pinnedConflicts.length}
          aria-live="polite"
        >
          {overlapNote}
        </p>
        {expandNote && view === 'canvas' ? (
          <p
            className="ks-format-note"
            role="status"
            data-testid="ks-expand-collision"
            data-node-id={expandNote.id}
          >
            The expanded card covers {expandNote.count}{' '}
            {expandNote.count === 1 ? 'other card' : 'other cards'}. Use Auto format to rearrange,
            or move it.
          </p>
        ) : null}
      </header>
      {runs && activeNodes.length ? (
        <nav
          className="ks-active-runs"
          aria-label="Runs in progress"
          data-testid="ks-active-runs"
          data-count={activeNodes.length}
        >
          <span className="ks-active-runs-label">
            {activeNodes.length === 1
              ? '1 run in progress'
              : `${activeNodes.length} runs in progress`}
          </span>
          <ul>
            {activeNodes.slice(0, 3).map((node) => {
              const runId = runIds[node.id] ?? nodeRunId(node);
              const open = () => viewRun(node.id, { reveal: true });
              return (
                <li key={node.id}>
                  {runLinks && runId ? (
                    <a
                      href={runLinks.href({ nodeId: node.id, runId })}
                      data-testid="ks-view-run"
                      data-node-id={node.id}
                      onClick={(event) => {
                        if (!isPlainClick(event)) return;
                        event.preventDefault();
                        open();
                      }}
                    >
                      {node.title}
                    </a>
                  ) : (
                    <Button
                      size="sm"
                      variant="ghost"
                      data-testid="ks-view-run"
                      data-node-id={node.id}
                      onClick={open}
                    >
                      {node.title}
                    </Button>
                  )}
                  <span className="ks-muted">{statusLabel(node.status)}</span>
                </li>
              );
            })}
          </ul>
          {activeNodes.length > 3 ? (
            <span className="ks-muted">and {activeNodes.length - 3} more</span>
          ) : null}
        </nav>
      ) : null}
      {viewHint ? (
        <p className="ks-format-note" role="status" data-testid="ks-view-hint">
          {viewHint}
        </p>
      ) : null}
      {runGate && runs ? (
        <div className="ks-gate" data-testid="ks-run-gate">
          <section className="ks-unavailable" data-compact role="status">
            <h2>Questions can be saved but not run</h2>
            <p>{runGate}</p>
          </section>
        </div>
      ) : runGate ? (
        <div className="ks-gate" data-testid="ks-run-gate">
          <KeystoneUnavailable
            reason={
              capabilities?.generative.state !== 'ready'
                ? (capabilities?.generative.reason ?? 'provider_unconfigured')
                : (capabilities?.tools.reason ?? 'tools_unavailable')
            }
            isAdmin={isAdmin}
            compact
          />
        </div>
      ) : null}
      <div className="ks-main">
        <div className="ks-stage" data-format-preview={preview ? 'true' : undefined}>
          {view === 'canvas' ? (
            <KeystoneCanvas
              graph={graph}
              geometry={geometry}
              selectedId={selectedId}
              editable={canvasEditable}
              onSelect={select}
              onGeometryChange={onGeometryChange}
              onToggleCollapsed={toggleCollapsed}
              onInit={(instance) => {
                flow.current = instance;
                onCanvasInit?.(instance);
              }}
            />
          ) : selectedId ? (
            <BranchReader graph={graph} selectedId={selectedId} onSelect={select} />
          ) : null}
        </div>
        <div
          className="ks-side"
          ref={inspectorHeading}
          tabIndex={-1}
          role="region"
          aria-label="Selected question details"
        >
          {composer && composerParent ? (
            <BranchComposer
              key={composerToken.current}
              intent={composer.intent}
              parent={composerParent}
              exported={composer.exported}
              availableDatasets={availableDatasets}
              gated={
                (runs ? null : runGate) ??
                (capabilities?.actions.branch
                  ? null
                  : 'Your role cannot add questions to this investigation.')
              }
              saveAsDraft={!!runs}
              submitting={composer.submitting}
              submitError={composer.submitError}
              onSubmit={submit}
              onCancel={closeComposer}
            />
          ) : selected ? (
            <NodeInspector
              node={selected}
              parent={parent}
              evidence={evidence[selected.id] ?? { state: 'loading' }}
              branchBlocked={branchBlocked}
              branchGate={{ kind: branchGate.kind, next: branchGate.next }}
              onBranch={openComposer}
              onSelect={select}
              run={runs ? runControls(selected) : undefined}
              activity={runActivity(selected)}
            />
          ) : null}
        </div>
      </div>
      {noticeNode ? (
        <div className="ks-notice" role="status" data-testid="ks-new-result">
          <span>New result in “{noticeNode.title}”.</span>
          <Button
            size="sm"
            onClick={() => {
              select(noticeNode.id);
              reveal(noticeNode.id);
            }}
          >
            Show result
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setNotice(null)}>
            Dismiss
          </Button>
        </div>
      ) : null}
      <p className="sr-only" aria-live="polite">
        {announcement}
      </p>
      <output
        hidden
        data-testid="ks-stream-status"
        data-applied={stream.applied}
        data-duplicates={stream.duplicates}
        data-gaps={stream.gaps}
        data-invalid={stream.invalid}
      />
    </div>
  );
}
