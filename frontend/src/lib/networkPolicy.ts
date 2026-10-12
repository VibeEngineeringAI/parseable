import { ApiError } from './apiError';
import type { AlertTargetPolicy } from './types';

export const policyListFields = [
  'allowedDomains',
  'allowedCidrs',
  'deniedDomains',
  'deniedCidrs',
] as const;
export function decodeAlertTargetPolicy(value: unknown): AlertTargetPolicy {
  if (!value || typeof value !== 'object')
    throw new ApiError('Unexpected alert-target policy response', 502);
  const policy = value as Record<string, unknown>;
  if (
    typeof policy.allowPrivate !== 'boolean' ||
    typeof policy.allowInvalidTls !== 'boolean' ||
    !policyListFields.every(
      (key) =>
        Array.isArray(policy[key]) &&
        policy[key].every((entry: unknown) => typeof entry === 'string'),
    )
  )
    throw new ApiError('Unexpected alert-target policy response', 502);
  return {
    allowPrivate: policy.allowPrivate,
    allowInvalidTls: policy.allowInvalidTls,
    allowedDomains: [...(policy.allowedDomains as string[])],
    allowedCidrs: [...(policy.allowedCidrs as string[])],
    deniedDomains: [...(policy.deniedDomains as string[])],
    deniedCidrs: [...(policy.deniedCidrs as string[])],
  };
}
export const emptyAlertTargetPolicy = (): AlertTargetPolicy => ({
  allowPrivate: false,
  allowInvalidTls: false,
  allowedDomains: [],
  allowedCidrs: [],
  deniedDomains: [],
  deniedCidrs: [],
});
export const policyLines = (text: string) =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

/** Domain lists match literal hostnames and suffixes; URL/glob syntax never matches. */
export function invalidPolicyDomain(text: string): string | undefined {
  return policyLines(text).find((domain) => {
    const hostname = domain.endsWith('.') ? domain.slice(0, -1) : domain;
    // URL hosts canonicalize shortened/hex/octal IP spellings. The backend
    // compares the stored rule literally, so those spellings could never match.
    try {
      if (new URL(`https://${hostname}`).hostname !== hostname.toLowerCase()) return true;
    } catch {
      return true;
    }
    return (
      hostname.length > 253 ||
      !hostname
        .split('.')
        .every(
          (label) =>
            label.length >= 1 &&
            label.length <= 63 &&
            /^[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?$/i.test(label),
        )
    );
  });
}
