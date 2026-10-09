import type { SessionIdentity } from './types';
import { appPath } from './config';

const RETURN_PATH_KEY = 'parseable-return-path';

/** Accept only local application paths, never authentication endpoints or external origins. */
export function safeReturnPath(
  value: string | null | undefined,
  origin = window.location.origin,
): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || /[\\\u0000-\u001f]/.test(value))
    return '/';
  try {
    const url = new URL(value, origin);
    if (
      url.origin !== origin ||
      /^\/(?:api(?:\/|$)|login(?:\/|$)|oidc-not-configured(?:\/|$))/.test(url.pathname)
    )
      return '/';
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return '/';
  }
}

export function authEndpoint(action: 'login' | 'logout', path: string): string {
  const destination = action === 'logout' ? '/login' : safeReturnPath(path);
  const redirect = new URL(appPath(destination), window.location.origin).href;
  return `/api/v1/o/${action}?${new URLSearchParams({ redirect })}`;
}

export function rememberReturnPath(path: string) {
  sessionStorage.setItem(RETURN_PATH_KEY, safeReturnPath(path));
}

export function intendedReturnPath(search: string): string {
  const next = new URLSearchParams(search).get('next');
  return safeReturnPath(next ?? sessionStorage.getItem(RETURN_PATH_KEY));
}

export function startSso(path: string) {
  rememberReturnPath(path);
  sessionStorage.setItem('parseable-mode', 'live');
  clearSessionCookies();
  window.location.assign(authEndpoint('login', path));
}

/** Display-only hints; cookies never establish authentication or permissions. */
export function cookieIdentity(cookie = document.cookie): SessionIdentity | undefined {
  const values = new Map(
    cookie.split(';').map((part) => {
      const split = part.indexOf('=');
      const key = part.slice(0, split).trim();
      const value = part.slice(split + 1).trim();
      try {
        return [key, decodeURIComponent(value)] as const;
      } catch {
        return [key, value] as const;
      }
    }),
  );
  const id = values.get('user_id') || values.get('username');
  if (!id) return undefined;
  return { id, username: values.get('username') || id, source: 'cookie' };
}

/** The server currently leaves expired session cookies in the browser. */
export function clearSessionCookies() {
  for (const name of ['session', 'username', 'user_id']) {
    document.cookie = `${name}=; Max-Age=0; Path=/; SameSite=Lax`;
  }
}
