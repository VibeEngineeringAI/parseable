import { Button } from '../../components/ui';

/**
 * Why branching is unavailable. `read_only` cannot change by waiting (the role lacks
 * the action); `waiting` clears once the question has a completed answer.
 */
export type BranchGateKind = 'read_only' | 'waiting';

/**
 * The two branch actions. Both create a child of the selected node and inherit only
 * that node's exported context; they differ in intent, not in what the child sees.
 */
export function BranchActions({
  blocked,
  kind = 'waiting',
  next = null,
  onBranch,
}: {
  blocked: string | null;
  kind?: BranchGateKind;
  /** What the user can do to make branching available, when anything. */
  next?: string | null;
  onBranch: (intent: 'follow_up' | 'explore') => void;
}) {
  const state = blocked === null ? 'ready' : kind === 'read_only' ? 'read-only' : 'waiting';
  const describedBy = blocked
    ? next
      ? 'ks-branch-blocked ks-branch-next'
      : 'ks-branch-blocked'
    : 'ks-branch-help';
  return (
    <section
      className="ks-branch"
      aria-labelledby="ks-branch-title"
      data-testid="ks-branch"
      data-state={state}
    >
      <h3 id="ks-branch-title">Add a question from this answer</h3>
      <p id="ks-branch-help" className="ks-muted">
        <strong>Follow up</strong> asks about this answer. <strong>Explore</strong> asks a different
        question from the same point. Either way the new question sees only this question, its
        answer, its scope and the sources you choose to pass on.
      </p>
      <div className="ks-branch-actions" role="group" aria-label="Branch from this question">
        <Button
          variant="primary"
          disabled={blocked !== null}
          aria-describedby={describedBy}
          onClick={() => onBranch('follow_up')}
          data-testid="ks-follow-up"
        >
          Follow up on answer
        </Button>
        <Button
          disabled={blocked !== null}
          aria-describedby={describedBy}
          onClick={() => onBranch('explore')}
          data-testid="ks-explore"
        >
          Explore another angle
        </Button>
        {blocked ? (
          <p
            id="ks-branch-blocked"
            className={kind === 'read_only' ? 'ks-note' : 'ks-muted'}
            data-testid="ks-branch-blocked"
          >
            {blocked}
          </p>
        ) : null}
        {blocked && next ? (
          <p id="ks-branch-next" className="ks-muted" data-testid="ks-branch-next">
            {next}
          </p>
        ) : null}
      </div>
    </section>
  );
}
