import type { SessionIdentity } from '../../lib/types';

export function moveColumn(fields: string[], source: string, target: string): string[] {
  const from = fields.indexOf(source),
    to = fields.indexOf(target);
  if (from < 0 || to < 0 || from === to) return fields;
  const next = [...fields];
  next.splice(to, 0, ...next.splice(from, 1));
  return next;
}

export function readColumnOrder(value: unknown): string[] | undefined {
  return Array.isArray(value) &&
    value.length > 0 &&
    value.every((field) => typeof field === 'string') &&
    new Set(value).size === value.length
    ? value
    : undefined;
}

/** Retain known preferences, and append newly returned fields in their original order. */
export function orderedColumns(fields: string[], order?: string[]): string[] {
  return order
    ? [
        ...order.filter((field) => fields.includes(field)),
        ...fields.filter((field) => !order.includes(field)),
      ]
    : fields;
}

export function columnStorageKey(
  mode: 'live' | 'demo',
  identity: SessionIdentity | undefined,
  table: string,
  server = typeof location === 'undefined' ? '' : location.origin,
): string | null {
  const owner = mode === 'demo' ? 'demo' : identity?.id;
  return owner ? `parseable-columns:v1:${JSON.stringify([server, mode, owner, table])}` : null;
}

/** Keep explicit hidden fields hidden, while exposing fields introduced by a changed query. */
export function reconcileSelectedColumns(
  fields: string[],
  selected?: string[],
  known = selected,
): string[] | undefined {
  if (!selected || !fields.length) return selected;
  const next = [
    ...selected.filter((field) => fields.includes(field)),
    ...fields.filter((field) => !selected.includes(field) && !known?.includes(field)),
  ];
  return next.length ? next : undefined;
}
