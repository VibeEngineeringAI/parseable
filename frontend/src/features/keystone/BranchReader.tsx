import type { KeyboardEvent } from 'react';
import { Button } from '../../components/ui';
import { neighbours } from '../../lib/keystone/graph';
import type { InvestigationGraph } from '../../lib/keystone/types';
import { StatusBadge } from './StatusBadge';

export interface BranchReaderProps {
  graph: InvestigationGraph;
  selectedId: string;
  onSelect: (id: string) => void;
}

/**
 * A readable exchange for one node and its direct parent, with keyboard movement
 * along the tree. Navigation never runs a query or changes any run's context.
 */
export function BranchReader({ graph, selectedId, onSelect }: BranchReaderProps) {
  const node = graph.nodes.find((item) => item.id === selectedId);
  if (!node) return null;
  const { parent, children, siblings, index } = neighbours(graph, selectedId);
  const previous = index > 0 ? siblings[index - 1] : null;
  const next = index >= 0 && index < siblings.length - 1 ? siblings[index + 1] : null;

  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.target !== event.currentTarget) return;
    const target =
      event.key === 'ArrowUp'
        ? parent
        : event.key === 'ArrowDown'
          ? (children[0] ?? null)
          : event.key === 'ArrowLeft'
            ? previous
            : event.key === 'ArrowRight'
              ? next
              : event.key === 'Home'
                ? (graph.nodes.find((item) => item.id === graph.rootNodeId) ?? null)
                : undefined;
    if (target === undefined) return;
    event.preventDefault();
    if (target) onSelect(target.id);
  }

  return (
    <section
      className="ks-reader"
      aria-label="Branch reader"
      aria-describedby="ks-reader-keys"
      tabIndex={0}
      onKeyDown={onKeyDown}
      data-testid="ks-reader"
      data-node-id={node.id}
    >
      <p id="ks-reader-keys" className="sr-only">
        Up arrow opens the parent question, down arrow the first follow-up, left and right arrows
        move between branches, Home returns to the starting question.
      </p>
      {parent ? (
        <div className="ks-reader-parent" data-testid="ks-reader-parent">
          <Button variant="ghost" className="ks-reader-up" onClick={() => onSelect(parent.id)}>
            Parent question: {parent.title}
          </Button>
          {parent.answer ? <p className="ks-reader-quote">{parent.answer}</p> : null}
        </div>
      ) : null}
      <article className="ks-reader-turn" aria-labelledby="ks-reader-title">
        <header>
          <h2 id="ks-reader-title">{node.title}</h2>
          <StatusBadge status={node.status} />
        </header>
        <p className="ks-reader-question">{node.prompt}</p>
        <p className="ks-prose" data-testid="ks-reader-answer">
          {node.answer ?? 'No answer yet.'}
        </p>
      </article>
      {siblings.length > 1 ? (
        <nav className="ks-reader-siblings" aria-label="Branches at this level">
          <Button disabled={!previous} onClick={() => previous && onSelect(previous.id)}>
            Previous branch
          </Button>
          <span aria-live="polite" data-testid="ks-reader-position">
            Branch {index + 1} of {siblings.length}
          </span>
          <Button disabled={!next} onClick={() => next && onSelect(next.id)}>
            Next branch
          </Button>
        </nav>
      ) : null}
      {children.length ? (
        <nav aria-label="Follow-ups from this question">
          <h3>Follow-ups ({children.length})</h3>
          <ul className="ks-reader-children">
            {children.map((child) => (
              <li key={child.id}>
                <Button variant="ghost" onClick={() => onSelect(child.id)}>
                  {child.title}
                </Button>
                <StatusBadge status={child.status} />
              </li>
            ))}
          </ul>
        </nav>
      ) : (
        <p className="ks-muted">No follow-ups yet.</p>
      )}
    </section>
  );
}
