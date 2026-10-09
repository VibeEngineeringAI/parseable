import type { AlertTarget, AlertTargetRequest, AlertTargetType } from '../../lib/types';
import { createId } from '../../lib/ids';

export function targetType(target: AlertTarget): AlertTargetType {
  return target.type === 'webhook' &&
    !target.headers &&
    (Object.hasOwn(target, 'username') || Object.hasOwn(target, 'password'))
    ? 'alertManager'
    : target.type;
}
export const targetTypeLabel = (type: AlertTargetType) =>
  type === 'slack' ? 'Slack' : type === 'alertManager' ? 'Alertmanager' : 'Webhook';
export type TargetDraft = {
  name: string;
  type: AlertTargetType;
  endpoint: string;
  skipTls: boolean;
  username: string;
  password: string;
  headers: Array<{ id: string; key: string; value: string }>;
};
export function targetDraft(target?: AlertTarget): TargetDraft {
  return {
    name: target?.name ?? '',
    type: target ? targetType(target) : 'webhook',
    endpoint: '',
    skipTls: target?.skipTlsCheck ?? false,
    username: target?.username ?? '',
    password: '',
    headers: Object.keys(target?.headers ?? {}).map((key) => ({ id: createId(), key, value: '' })),
  };
}
const deniedHeaders = [
  'host',
  'content-length',
  'transfer-encoding',
  'connection',
  'upgrade',
  'proxy-authorization',
  'proxy-authenticate',
  'cookie',
];
export function validateTarget(draft: TargetDraft): Partial<Record<keyof TargetDraft, string>> {
  const errors: Partial<Record<keyof TargetDraft, string>> = {};
  if (!draft.name.trim()) errors.name = 'Enter a target name.';
  try {
    const url = new URL(draft.endpoint);
    if (
      !['https:', 'http:'].includes(url.protocol) ||
      !url.hostname ||
      draft.endpoint.includes('********') ||
      url.username ||
      url.password
    )
      throw new Error();
    if (
      draft.type === 'slack' &&
      (url.protocol !== 'https:' ||
        !['hooks.slack.com', 'hooks.slack-gov.com'].includes(url.hostname))
    )
      errors.endpoint = 'Use an HTTPS webhook URL on hooks.slack.com or hooks.slack-gov.com.';
  } catch {
    errors.endpoint = 'Enter a complete HTTP or HTTPS endpoint URL.';
  }
  if (draft.type === 'alertManager' && Boolean(draft.username) !== Boolean(draft.password))
    errors.password = 'Enter both username and password, or leave both empty.';
  if (draft.type === 'webhook') {
    const names = new Set<string>();
    for (const header of draft.headers) {
      if (!header.key && !header.value) continue;
      const name = header.key.trim().toLowerCase();
      if (
        !/^[!#$%&'*+.^_`|~\w-]+$/.test(header.key.trim()) ||
        !header.value ||
        /[\r\n]/.test(header.value)
      )
        errors.headers =
          'Each header needs a valid name and a non-empty value without line breaks.';
      else if (deniedHeaders.includes(name))
        errors.headers = `The ${header.key} header is blocked by outbound policy.`;
      else if (names.has(name)) errors.headers = 'Header names must be unique.';
      names.add(name);
    }
  }
  return errors;
}
export function buildTargetPayload(draft: TargetDraft): AlertTargetRequest {
  const base = { name: draft.name.trim(), type: draft.type, endpoint: draft.endpoint.trim() };
  if (draft.type === 'slack') return { ...base, type: 'slack' };
  if (draft.type === 'alertManager')
    return {
      ...base,
      type: 'alertManager',
      skipTlsCheck: draft.skipTls,
      ...(draft.username ? { username: draft.username, password: draft.password } : {}),
    };
  return {
    ...base,
    type: 'webhook',
    skipTlsCheck: draft.skipTls,
    headers: Object.fromEntries(
      draft.headers
        .filter((header) => header.key.trim())
        .map((header) => [header.key.trim(), header.value]),
    ),
  };
}
