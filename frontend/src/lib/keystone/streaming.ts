import type { GraphNode, RunEvent } from './types';

const TERMINAL = ['completed', 'partial', 'cancelled', 'failed', 'interrupted'];

/**
 * Folds one already-sequenced event into its node. Deltas are previews; a checkpoint
 * replaces the text. `seenEvidence` holds evidence IDs already counted for the node.
 * Events after a terminal state are ignored, so a late delta cannot reopen a
 * completed or cancelled node.
 */
export function applyRunEvent(
  node: GraphNode,
  event: RunEvent,
  seenEvidence: ReadonlySet<string> = new Set(),
): GraphNode {
  if (event.nodeId !== node.id || TERMINAL.includes(node.status)) return node;
  switch (event.kind) {
    case 'status':
      return { ...node, status: event.status };
    case 'answer_delta':
      return { ...node, answer: (node.answer ?? '') + event.text };
    case 'answer_checkpoint':
      return { ...node, answer: event.text };
    case 'evidence':
      return seenEvidence.has(event.evidence.id)
        ? node
        : { ...node, evidenceCount: node.evidenceCount + 1 };
    case 'terminal':
      return { ...node, status: event.status };
  }
}

export function isTerminal(status: GraphNode['status']) {
  return TERMINAL.includes(status);
}
