import { ApiError } from '../../lib/client';
import { errorMessage } from '../../lib/errors';
import type { DatasetRetention } from '../../lib/types';

const deniedNames = new Set([
  'select',
  'from',
  'where',
  'group',
  'by',
  'order',
  'limit',
  'offset',
  'join',
  'and',
  'sql',
]);
export const gib = 1024 ** 3;

export function validateDatasetName(name: string): string | undefined {
  if (!name) return 'Stream name cannot be empty';
  for (const character of name) {
    if (character === ' ') return 'Stream name cannot contain whitespace';
    if (!/^[\p{Alphabetic}\p{Number}_-]$/u.test(character))
      return `Stream name cannot contain special character: ${character}`;
  }
  if (deniedNames.has(name)) return 'SQL keyword cannot be used as stream name';
  if (name === 'DEFAULT_TENANT')
    return 'The stream name DEFAULT_TENANT is reserved for internal use';
  return undefined;
}

export function validateCustomPartition(value: string): string | undefined {
  if (value.includes(',')) return 'Maximum 1 custom partition key is supported';
  if (value.includes('.')) return `custom partition field ${value} must not contain '.'`;
  return undefined;
}

export function retentionDays(value: string): number | undefined {
  if (!/^\d+$/.test(value)) return undefined;
  const days = Number(value);
  return days >= 1 && days <= 36500 ? days : undefined;
}

export function retentionFromDays(days: number): DatasetRetention {
  return [
    { description: `Delete data older than ${days} days`, action: 'delete', duration: `${days}d` },
  ];
}

export function hotTierBytes(value: string): string | undefined {
  if (!/^\d+(?:\.\d+)?$/.test(value)) return undefined;
  const bytes = Number(value) * gib;
  return Number.isSafeInteger(bytes) && bytes >= 10 * gib ? `${bytes} Bytes` : undefined;
}

export function hotTierUnavailable(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    /hot tier (?:is )?not (?:enabled at the server config|configured (?:at|on) the server)/i.test(
      error.message,
    )
  );
}

export function datasetError(error: unknown, action: string): string {
  return error instanceof ApiError && error.status === 403
    ? `You don't have permission to ${action}. ${error.message}`
    : errorMessage(error);
}
