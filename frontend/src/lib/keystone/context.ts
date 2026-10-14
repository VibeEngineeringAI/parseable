import { sha256 } from '../sha256';
import {
  ACTIVE_STATUSES,
  type ParentExport,
  type PinnedParentExport,
  type ScopeVersion,
} from './types';

/** JSON with object keys sorted at every level: the exact bytes that are hashed. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
      )
      .join(',')}}`;
  return JSON.stringify(value);
}

/**
 * Pins a parent export when the composer opens. Later graph updates never change a
 * pinned export, so the request names exactly the version and bytes the user reviewed.
 */
export async function pinParentExport(value: ParentExport): Promise<PinnedParentExport> {
  const bytes = canonicalJson(value);
  return {
    value: Object.freeze(structuredClone(value)),
    bytes,
    sha256: value.exportHash ?? (await sha256(bytes)),
  };
}

export type BranchBlock =
  | { kind: 'ok' }
  | { kind: 'parent_active' }
  | { kind: 'parent_not_completed'; status: string }
  | { kind: 'no_answer' };

/** Default rule: branch only from a completed parent with an answer. */
export function branchEligibility(parent: ParentExport): BranchBlock {
  if (ACTIVE_STATUSES.includes(parent.parentStatus)) return { kind: 'parent_active' };
  if (parent.parentStatus !== 'completed')
    return { kind: 'parent_not_completed', status: parent.parentStatus };
  if (!parent.answer.trim()) return { kind: 'no_answer' };
  return { kind: 'ok' };
}

export interface ScopeDiff {
  changed: boolean;
  datasetsAdded: string[];
  datasetsRemoved: string[];
  startChanged: boolean;
  endChanged: boolean;
  timezoneChanged: boolean;
  filtersAdded: string[];
  filtersRemoved: string[];
  parentDurationMs: number;
  childDurationMs: number;
  /** Any added dataset, earlier start, later end or removed filter. */
  widens: boolean;
}

export function scopeDiff(parent: ScopeVersion, child: Omit<ScopeVersion, 'id'>): ScopeDiff {
  const minus = (a: string[], b: string[]) => a.filter((item) => !b.includes(item));
  const datasetsAdded = minus(child.datasets, parent.datasets);
  const datasetsRemoved = minus(parent.datasets, child.datasets);
  const filtersAdded = minus(child.filters, parent.filters);
  const filtersRemoved = minus(parent.filters, child.filters);
  const parentStart = Date.parse(parent.start);
  const parentEnd = Date.parse(parent.end);
  const childStart = Date.parse(child.start);
  const childEnd = Date.parse(child.end);
  const startChanged = parentStart !== childStart;
  const endChanged = parentEnd !== childEnd;
  const timezoneChanged = parent.timezone !== child.timezone;
  return {
    changed:
      datasetsAdded.length > 0 ||
      datasetsRemoved.length > 0 ||
      filtersAdded.length > 0 ||
      filtersRemoved.length > 0 ||
      startChanged ||
      endChanged ||
      timezoneChanged,
    datasetsAdded,
    datasetsRemoved,
    startChanged,
    endChanged,
    timezoneChanged,
    filtersAdded,
    filtersRemoved,
    parentDurationMs: parentEnd - parentStart,
    childDurationMs: childEnd - childStart,
    widens:
      datasetsAdded.length > 0 ||
      filtersRemoved.length > 0 ||
      childStart < parentStart ||
      childEnd > parentEnd,
  };
}

const UNITS: [number, string][] = [
  [86_400_000, 'day'],
  [3_600_000, 'hour'],
  [60_000, 'minute'],
];

/**
 * The two largest whole units, with windows under two days in hours: "30 days",
 * "24 hours", "36 hours", "3 days 6 hours". Never rounds up.
 */
export function formatDuration(ms: number): string {
  if (ms <= 0) return '0 minutes';
  const parts: string[] = [];
  let rest = ms;
  for (const [size, unit] of ms < 2 * UNITS[0][0] ? UNITS.slice(1) : UNITS) {
    const count = Math.floor(rest / size);
    if (count > 0 && parts.length < 2) {
      parts.push(`${count} ${unit}${count === 1 ? '' : 's'}`);
      rest -= count * size;
    }
  }
  if (rest > 0 && parts.length === 0) return `${Math.ceil(ms / 1000)} seconds`;
  return parts.join(' ');
}

/** UTC display for absolute bounds: 2026-09-13 14:00 UTC. */
export function formatInstant(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}
