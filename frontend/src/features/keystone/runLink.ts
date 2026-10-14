/**
 * Deep links within one investigation: `?node=<id>&run=<id>`. Both are identifiers
 * the server issued; opening a link only selects them, and the server re-authorizes
 * every read it causes.
 */
export interface RunLinkTarget {
  nodeId: string | null;
  runId: string | null;
}

export const NODE_PARAM = 'node';
export const RUN_PARAM = 'run';

export function readRunLink(params: URLSearchParams): RunLinkTarget {
  return {
    nodeId: params.get(NODE_PARAM) || null,
    runId: params.get(RUN_PARAM) || null,
  };
}

/** Returns `params` with the target applied; other parameters are kept. */
export function writeRunLink(params: URLSearchParams, target: RunLinkTarget): URLSearchParams {
  const next = new URLSearchParams(params);
  if (target.nodeId) next.set(NODE_PARAM, target.nodeId);
  else next.delete(NODE_PARAM);
  if (target.nodeId && target.runId) next.set(RUN_PARAM, target.runId);
  else next.delete(RUN_PARAM);
  return next;
}

/** `base` is the investigation's routed path, already including any app base path. */
export function runHref(base: string, target: RunLinkTarget): string {
  const query = writeRunLink(new URLSearchParams(), target).toString();
  return query ? `${base}?${query}` : base;
}

/** A plain primary click is handled in place; modified clicks open the link normally. */
export function isPlainClick(event: {
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}) {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}
