import type { ReactNode } from 'react';
import { Button, Spinner } from '../../components/ui';
import { formatDuration, formatInstant } from '../../lib/keystone/context';
import type { Evidence, GraphNode } from '../../lib/keystone/types';
import { BranchActions, type BranchGateKind } from './BranchActions';
import { EvidenceCard } from './EvidenceCard';
import { RunControls, type RunControlsProps } from './RunControls';
import { StatusBadge } from './StatusBadge';

export type EvidenceState =
  | { state: 'loading' }
  | { state: 'ready'; items: Evidence[] }
  | { state: 'error'; message: string };

export interface NodeInspectorProps {
  node: GraphNode;
  parent: GraphNode | null;
  evidence: EvidenceState;
  /** Why branching is unavailable, or null when it is allowed. */
  branchBlocked: string | null;
  /** Whether a block is permanent for this role, and what would lift it. */
  branchGate?: { kind: BranchGateKind; next: string | null };
  onBranch: (intent: 'follow_up' | 'explore') => void;
  onSelect: (id: string) => void;
  /** Explicit run controls; omitted where runs are not offered. */
  run?: RunControlsProps;
  /** The selected run's progress, shown above the question. */
  activity?: ReactNode;
}

export function ScopeFacts({ node }: { node: GraphNode }) {
  const duration = Date.parse(node.scope.end) - Date.parse(node.scope.start);
  return (
    <dl className="ks-facts">
      <div>
        <dt>Datasets</dt>
        <dd>{node.scope.datasets.join(', ')}</dd>
      </div>
      <div>
        <dt>Window</dt>
        <dd>
          {formatInstant(node.scope.start)} to {formatInstant(node.scope.end)} (
          {formatDuration(duration)})
        </dd>
      </div>
      {node.scope.filters.length ? (
        <div>
          <dt>Filters</dt>
          <dd>{node.scope.filters.join('; ')}</dd>
        </div>
      ) : null}
    </dl>
  );
}

export function NodeInspector({
  node,
  parent,
  evidence,
  branchBlocked,
  branchGate,
  onBranch,
  onSelect,
  run,
  activity,
}: NodeInspectorProps) {
  return (
    <aside
      className="ks-inspector"
      aria-labelledby="ks-inspector-title"
      data-testid="ks-inspector"
      data-node-id={node.id}
    >
      <header className="ks-inspector-header">
        <h2 id="ks-inspector-title">{node.title}</h2>
        <StatusBadge status={node.status} />
      </header>
      {branchBlocked === null ? (
        <Button
          variant="primary"
          onClick={() => onBranch('follow_up')}
          data-testid="ks-quick-follow-up"
        >
          Add follow-up question
        </Button>
      ) : null}
      {parent ? (
        <p className="ks-lineage">
          {node.intent === 'explore' ? 'Explores another angle from ' : 'Follows up on '}
          <Button variant="ghost" size="sm" onClick={() => onSelect(parent.id)}>
            {parent.title}
          </Button>
          <span className="ks-muted"> (version {node.parentVersion})</span>
        </p>
      ) : (
        <p className="ks-lineage ks-muted">Starting question. It has no inherited context.</p>
      )}
      {run ? <RunControls {...run} /> : null}
      {activity}
      <section aria-labelledby="ks-q">
        <h3 id="ks-q">Question</h3>
        <p className="ks-prose">{node.prompt}</p>
      </section>
      <section aria-labelledby="ks-a">
        <h3 id="ks-a">Answer</h3>
        {node.answer ? (
          <p className="ks-prose" data-testid="ks-inspector-answer">
            {node.answer}
          </p>
        ) : (
          <p className="ks-muted">No answer yet.</p>
        )}
        {node.status === 'partial' ||
        node.status === 'cancelled' ||
        node.status === 'interrupted' ? (
          <p className="ks-note" data-tone="warning">
            This answer is incomplete. Completed sources below are kept; unfinished work is not
            shown as done.
          </p>
        ) : null}
      </section>
      <BranchActions
        blocked={branchBlocked}
        kind={branchGate?.kind}
        next={branchGate?.next ?? null}
        onBranch={onBranch}
      />
      <section aria-labelledby="ks-scope">
        <h3 id="ks-scope">
          Scope{' '}
          {node.scopeChanged ? (
            <span className="ks-chip" data-tone="warning">
              Changed from parent
            </span>
          ) : null}
        </h3>
        <ScopeFacts node={node} />
        {node.contextHash ? (
          <p className="ks-muted">
            Context hash <code>{node.contextHash.slice(0, 16)}</code>
          </p>
        ) : null}
      </section>
      <section aria-labelledby="ks-ev" className="ks-evidence-list">
        <h3 id="ks-ev">Sources ({node.evidenceCount})</h3>
        {evidence.state === 'loading' ? (
          <Spinner label="Loading sources" />
        ) : evidence.state === 'error' ? (
          <p className="ks-note" data-tone="danger">
            {evidence.message}
          </p>
        ) : evidence.items.length === 0 ? (
          <p className="ks-muted">No sources were recorded for this question.</p>
        ) : (
          evidence.items.map((item) => <EvidenceCard key={item.id} evidence={item} />)
        )}
      </section>
    </aside>
  );
}
