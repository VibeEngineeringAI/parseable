import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useHref, useSearchParams } from 'react-router-dom';
import { Button, Spinner } from '../../components/ui';
import { PageHeader } from '../../components/explorer/PageHeader';
import { formatInstant } from '../../lib/keystone/context';
import type { TransportFailure } from '../../lib/keystone/transport';
import { KeystoneWorkspace, type WorkspaceRunLinks, type WorkspaceRuns } from './KeystoneWorkspace';
import type { FollowStatus } from './RunActivity';
import { readRunLink, runHref, writeRunLink, type RunLinkTarget } from './runLink';
import { NewInvestigation } from './NewInvestigation';
import { ProviderSetup } from './ProviderSetup';
import type {
  InvestigationSummary,
  KeystonePageCapabilities,
  KeystonePageTransport,
} from './pageContract';
import { settingsClassicPath } from '../../lib/settingsCapabilities';
import { executionMessage, pageGate, requestMessage, storageMessage } from './readiness';
import { createRunFollower, type RunFollower } from './runFollower';
import './keystone.css';

export interface KeystoneFullPageProps {
  transport: KeystonePageTransport;
  /** Reopens this investigation; omitted on the index. */
  investigationId?: string;
  loadDatasets: (signal: AbortSignal) => Promise<string[]>;
  onOpen: (id: string) => void;
  createIdempotencyKey?: () => string;
  /**
   * The classic UI owns the root path. When true, pages that cannot open an
   * investigation link to the same classic page.
   */
  classicAvailable?: boolean;
}

/**
 * A plain link to the classic page outside this router. `settingsClassicPath` encodes
 * the ID as one segment, and classic `/keystone` paths map to themselves here, so the
 * link never redirects back.
 */
function ClassicLink({ investigationId }: { investigationId?: string }) {
  return (
    <p className="ks-note" data-testid="ks-classic-link">
      <a href={settingsClassicPath('keystone', investigationId)}>
        Open {investigationId ? 'this investigation' : 'Keystone'} in the classic UI
      </a>
      . Investigations started there open there; your permissions still apply.
    </p>
  );
}

type Capabilities =
  | { state: 'loading' }
  | { state: 'error'; kind: TransportFailure['kind']; message: string }
  | { state: 'ready'; value: KeystonePageCapabilities };

function defaultKey() {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `ks-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function capabilityError(failure: TransportFailure) {
  return failure.kind === 'gated'
    ? 'This server does not provide investigations.'
    : requestMessage(failure);
}

/** Two independent facts: whether saved work is usable, and whether questions can run. */
function Readiness({
  capabilities,
  isAdmin,
}: {
  capabilities: KeystonePageCapabilities;
  isAdmin: boolean;
}) {
  const storage = storageMessage(capabilities.storage.state);
  const execution = executionMessage(capabilities.execution, isAdmin);
  return (
    <dl className="ks-readiness" data-testid="ks-readiness">
      <div data-state={storage ? 'unavailable' : 'ready'} data-testid="ks-readiness-storage">
        <dt>Saved investigations</dt>
        <dd>{storage ?? 'Available. Questions you save are kept on this server.'}</dd>
      </div>
      <div data-state={execution ? 'unavailable' : 'ready'} data-testid="ks-readiness-execution">
        <dt>Running questions</dt>
        <dd>{execution ?? 'Available.'}</dd>
      </div>
    </dl>
  );
}

type ListState =
  | { state: 'loading' }
  | { state: 'error'; message: string }
  | { state: 'ready'; items: InvestigationSummary[]; next: string | null; more: boolean };

function InvestigationList({ transport }: { transport: KeystonePageTransport }) {
  const [list, setList] = useState<ListState>({ state: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [moreError, setMoreError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setList({ state: 'loading' });
    transport.listInvestigations(null, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      setList(
        result.ok
          ? { state: 'ready', items: result.value.items, next: result.value.next, more: false }
          : { state: 'error', message: requestMessage(result) },
      );
    });
    return () => controller.abort();
  }, [transport, attempt]);

  async function loadMore() {
    if (list.state !== 'ready' || !list.next || list.more) return;
    setMoreError(null);
    setList({ ...list, more: true });
    const result = await transport.listInvestigations(list.next);
    setList((current) =>
      current.state !== 'ready'
        ? current
        : result.ok
          ? {
              state: 'ready',
              // A page boundary can repeat an item; keep the first occurrence.
              items: [
                ...current.items,
                ...result.value.items.filter(
                  (item) => !current.items.some((existing) => existing.id === item.id),
                ),
              ],
              next: result.value.next,
              more: false,
            }
          : { ...current, more: false },
    );
    if (!result.ok) setMoreError(requestMessage(result));
  }

  return (
    <section className="ks-saved" aria-labelledby="ks-saved-title" data-testid="ks-saved">
      <h2 id="ks-saved-title">Saved investigations</h2>
      {list.state === 'loading' ? (
        <Spinner label="Loading investigations" />
      ) : list.state === 'error' ? (
        <div className="ks-note" data-tone="danger" role="alert" data-testid="ks-saved-error">
          <p>{list.message}</p>
          <Button size="sm" onClick={() => setAttempt((value) => value + 1)}>
            Try again
          </Button>
        </div>
      ) : list.items.length === 0 ? (
        <p className="ks-muted" data-testid="ks-saved-empty">
          Nothing saved yet. Your first question starts an investigation.
        </p>
      ) : (
        <>
          <ul className="ks-saved-list">
            {list.items.map((item) => (
              <li key={item.id}>
                <Link to={`/keystone/${encodeURIComponent(item.id)}`} data-testid="ks-saved-item">
                  {item.title}
                </Link>
                <span className="ks-muted">Updated {formatInstant(item.updatedAt)}</span>
              </li>
            ))}
          </ul>
          {list.next ? (
            <Button size="sm" disabled={list.more} onClick={() => void loadMore()}>
              {list.more ? 'Loading' : 'Show more'}
            </Button>
          ) : null}
          {moreError ? (
            <p className="ks-note" data-tone="danger" role="alert">
              {moreError}
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}

function streamProblem(failure: TransportFailure) {
  return failure.kind === 'gated'
    ? 'Live results are not available on this server. Reopen the investigation later to see the outcome.'
    : `Live results stopped: ${requestMessage(failure)} Reopen the investigation to see the latest state.`;
}

function Investigation({
  transport,
  investigationId,
  capabilities,
  loadDatasets,
  createIdempotencyKey,
  loadFallback,
}: {
  transport: KeystonePageTransport;
  investigationId: string;
  capabilities: KeystonePageCapabilities;
  loadDatasets: (signal: AbortSignal) => Promise<string[]>;
  createIdempotencyKey: () => string;
  loadFallback?: ReactNode;
}) {
  const isAdmin = capabilities.workspace.actions.manageProviders;

  // The composer's scope editor offers the same datasets as the new-investigation form.
  // Mounted only once the page gate is open, so a page that cannot open the
  // investigation never lists datasets; unmounting or a new ID aborts the load.
  const [datasets, setDatasets] = useState<string[]>([]);
  useEffect(() => {
    const controller = new AbortController();
    setDatasets([]);
    loadDatasets(controller.signal)
      .then((names) => {
        if (!controller.signal.aborted) setDatasets(names.filter((name) => !name.startsWith('_')));
      })
      .catch(() => {
        /* Scope changes then offer only the parent's datasets. */
      });
    return () => controller.abort();
  }, [loadDatasets, investigationId]);

  // Created in an effect so a remount never reuses a closed follower.
  const [follower, setFollower] = useState<RunFollower | null>(null);
  const [streamNotes, setStreamNotes] = useState<Record<string, string>>({});
  const [followStates, setFollowStates] = useState<Record<string, FollowStatus>>({});
  useEffect(() => {
    const next = createRunFollower(transport, investigationId);
    const stop = next.onState((runId, state) => {
      setFollowStates((current) =>
        current[runId] === state.state ? current : { ...current, [runId]: state.state },
      );
      setStreamNotes((current) => {
        if (state.state === 'unavailable')
          return { ...current, [runId]: streamProblem(state.failure) };
        if (!(runId in current)) return current;
        const { [runId]: _cleared, ...rest } = current;
        return rest;
      });
    });
    setFollower(next);
    return () => {
      stop();
      next.close();
    };
  }, [transport, investigationId]);

  // A repeated Run on the same node version reuses its key, so it cannot start twice.
  const runKeys = useRef(new Map<string, string>());
  const unavailable = executionMessage(capabilities.execution, isAdmin);
  const runs = useMemo<WorkspaceRuns | undefined>(
    () =>
      follower
        ? {
            unavailable,
            start: async (nodeId, nodeVersion, expectedRevision) => {
              const slot = `${nodeId}@${nodeVersion}`;
              const key = runKeys.current.get(slot) ?? createIdempotencyKey();
              runKeys.current.set(slot, key);
              const result = await transport.startRun(investigationId, {
                nodeId,
                nodeVersion,
                expectedRevision,
                idempotencyKey: key,
              });
              if (result.ok) runKeys.current.delete(slot);
              return result;
            },
            cancel: (runId) => transport.cancelRun(investigationId, runId),
            follow: (runId) => follower.follow(runId),
            streamNotes,
            followStates,
          }
        : undefined,
    [
      follower,
      unavailable,
      transport,
      investigationId,
      createIdempotencyKey,
      streamNotes,
      followStates,
    ],
  );

  // `?node=&run=` selects a question and its run, so a reload or shared link reopens it.
  const [params, setParams] = useSearchParams();
  const base = useHref(`/keystone/${encodeURIComponent(investigationId)}`);
  const linked = readRunLink(params);
  const onSelect = useCallback(
    (target: RunLinkTarget) =>
      setParams((current) => writeRunLink(current, target), { replace: true }),
    [setParams],
  );
  const runLinks = useMemo<WorkspaceRunLinks>(
    () => ({
      target: { nodeId: linked.nodeId, runId: linked.runId },
      href: (target) => runHref(base, target),
      onSelect,
    }),
    [linked.nodeId, linked.runId, base, onSelect],
  );

  if (!runs || !follower) return <Spinner label="Opening investigation" />;
  return (
    <KeystoneWorkspace
      key={investigationId}
      transport={transport.workspace}
      investigationId={investigationId}
      events={follower}
      runs={runs}
      runLinks={runLinks}
      isAdmin={isAdmin}
      availableDatasets={datasets}
      createIdempotencyKey={createIdempotencyKey}
      loadFallback={loadFallback}
    />
  );
}

/**
 * The Keystone page. Storage readiness gates listing, saving and reopening; run
 * readiness is reported beside it and only gates the Run action. Nothing here
 * substitutes sample data for a server response.
 */
export function KeystoneFullPage({
  transport,
  investigationId,
  loadDatasets,
  onOpen,
  createIdempotencyKey = defaultKey,
  classicAvailable = false,
}: KeystoneFullPageProps) {
  const [capabilities, setCapabilities] = useState<Capabilities>({ state: 'loading' });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setCapabilities({ state: 'loading' });
    transport.capabilities(controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      setCapabilities(
        result.ok
          ? { state: 'ready', value: result.value }
          : { state: 'error', kind: result.kind, message: capabilityError(result) },
      );
    });
    return () => controller.abort();
  }, [transport, attempt]);

  const open = useCallback((item: InvestigationSummary) => onOpen(item.id), [onOpen]);

  const header = investigationId ? (
    <nav className="ks-page-back" aria-label="Breadcrumb">
      <Link to="/keystone">All investigations</Link>
    </nav>
  ) : (
    <PageHeader
      title="Investigations"
      description="Ask a question about your data, then follow up on any answer. A follow-up sees only its parent’s question, answer, scope and the sources you choose to pass on."
    />
  );

  const classic = classicAvailable ? <ClassicLink investigationId={investigationId} /> : null;

  let body;
  if (capabilities.state === 'loading') body = <Spinner label="Checking investigations" />;
  else if (capabilities.state === 'error')
    body = (
      <>
        <div
          className="ks-note"
          data-tone="danger"
          role="alert"
          data-testid="ks-page-error"
          data-kind={capabilities.kind}
        >
          <p>{capabilities.message}</p>
          <Button size="sm" onClick={() => setAttempt((value) => value + 1)}>
            Try again
          </Button>
        </div>
        {classic}
      </>
    );
  else {
    const value = capabilities.value;
    const isAdmin = value.workspace.actions.manageProviders;
    const storageReady = value.storage.state === 'ready';
    const gate = pageGate(value);
    if (gate === 'denied')
      body = (
        <>
          <p className="ks-note" data-tone="danger" data-testid="ks-page-denied">
            Your role does not include investigations. Ask an administrator for access.
          </p>
          {classic}
        </>
      );
    else if (investigationId)
      // The workspace reports run availability itself, beside the canvas.
      body =
        gate === 'open' ? (
          <Investigation
            transport={transport}
            investigationId={investigationId}
            capabilities={value}
            loadDatasets={loadDatasets}
            createIdempotencyKey={createIdempotencyKey}
            loadFallback={classic}
          />
        ) : (
          <>
            <Readiness capabilities={value} isAdmin={isAdmin} />
            {classic}
          </>
        );
    else
      body = (
        <>
          <Readiness capabilities={value} isAdmin={isAdmin} />
          {isAdmin && value.provider && transport.saveProviderCredential ? (
            <ProviderSetup
              provider={value.provider}
              save={transport.saveProviderCredential}
              onSaved={() => setAttempt((value) => value + 1)}
            />
          ) : null}
          {storageReady ? (
            <div className="ks-index">
              <InvestigationList transport={transport} />
              <NewInvestigation
                loadDatasets={loadDatasets}
                create={(request) => transport.createInvestigation(request)}
                onCreated={open}
                blocked={
                  value.workspace.actions.branch ? null : 'Your role cannot start investigations.'
                }
                createIdempotencyKey={createIdempotencyKey}
              />
            </div>
          ) : (
            classic
          )}
        </>
      );
  }

  return (
    <div
      className="page ks-page"
      data-testid="ks-page"
      data-state={capabilities.state}
      data-view={investigationId ? 'investigation' : 'index'}
    >
      {header}
      {body}
    </div>
  );
}
