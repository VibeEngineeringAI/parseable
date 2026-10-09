import { createDemoClient } from './demo';
import { authEndpoint, cookieIdentity } from './auth';
import { demoEnabled } from './config';
import { apiKey, groupRoles, object, roles, roleSources, strings, userRoles } from './teamContract';
import type { Dataset, LogRecord, ParseableClient } from './types';

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function checked(response: Response): Promise<Response> {
  if (!response.ok) {
    const body = await response.text();
    let detail: unknown = body;
    try {
      detail = JSON.parse(body);
    } catch {
      /* Backend errors can be plain text. */
    }
    const message =
      object(detail) && strings(detail.non_existent_roles)
        ? `Roles do not exist: ${detail.non_existent_roles.join(', ')}`
        : object(detail) && strings(detail.roles_not_assigned)
          ? `Roles are not assigned: ${detail.roles_not_assigned.join(', ')}`
          : object(detail) && typeof detail.message === 'string'
            ? detail.message
            : object(detail) && typeof detail.error === 'string'
              ? detail.error
              : body || response.statusText;
    throw new ApiError(message || `Request failed (${response.status})`, response.status, detail);
  }
  return response;
}

function malformed(endpoint: string): never {
  throw new ApiError(`Unexpected response from ${endpoint}`, 502);
}

async function readJson(
  endpoint: string,
  init: RequestInit,
  onUnauthorized?: () => void,
): Promise<unknown> {
  const response = await request(endpoint, init, onUnauthorized);
  try {
    return await response.json();
  } catch {
    return malformed(endpoint);
  }
}

async function request(endpoint: string, init: RequestInit, onUnauthorized?: () => void) {
  const response = await fetch(endpoint, { ...init, credentials: 'include' });
  if (response.status === 401) onUnauthorized?.();
  return checked(response);
}

async function readText(endpoint: string, init: RequestInit, onUnauthorized?: () => void) {
  const response = await request(endpoint, init, onUnauthorized);
  const text = await response.text();
  if (!text.trim()) return malformed(endpoint);
  return text;
}

function jsonBody(method: string, body: unknown): RequestInit {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

export function createClient({
  mode,
  onUnauthorized,
}: {
  mode: 'demo' | 'live';
  onUnauthorized?: () => void;
}): ParseableClient {
  if (mode === 'demo' && demoEnabled) return createDemoClient();
  const base = '/api/v1';
  const keys = '/api/prism/v1/apikeys';
  const user = (id: string) => `${base}/user/${encodeURIComponent(id)}`;
  const role = (name: string) => {
    if (name.toLowerCase() === 'default')
      throw new ApiError(
        'The name default is reserved for the default OIDC role endpoint. Choose another name.',
        400,
      );
    return `${base}/role/${encodeURIComponent(name)}`;
  };
  const mutate = async (endpoint: string, init: RequestInit) => {
    await request(endpoint, init, onUnauthorized);
  };
  return {
    async about(signal) {
      const endpoint = `${base}/about`;
      const data = await readJson(endpoint, { signal }, onUnauthorized);
      if (
        !object(data) ||
        (data.oidcActive !== undefined && typeof data.oidcActive !== 'boolean') ||
        (data.capabilities !== undefined && !object(data.capabilities))
      )
        return malformed(endpoint);
      const capabilities = object(data.capabilities) ? data.capabilities : {};
      if (
        ['oidcRoleMapping', 'oidcRoleSync'].some(
          (field) => capabilities[field] !== undefined && typeof capabilities[field] !== 'boolean',
        )
      )
        return malformed(endpoint);
      return {
        oidcActive: data.oidcActive === true,
        capabilities: {
          oidcRoleMapping: capabilities.oidcRoleMapping === true,
          oidcRoleSync: capabilities.oidcRoleSync === true,
        },
      };
    },
    async listUsers(signal) {
      const endpoint = `${base}/users`;
      const data = await readJson(endpoint, { signal }, onUnauthorized);
      if (!Array.isArray(data)) return malformed(endpoint);
      return data.map((item) => {
        if (!object(item)) return malformed(endpoint);
        const groups = item.groupRoles ?? item.group_roles;
        const memberships = item.userGroups ?? item.user_groups;
        if (
          typeof item.id !== 'string' ||
          typeof item.username !== 'string' ||
          (item.method !== 'native' && item.method !== 'oauth') ||
          !userRoles(item.roles) ||
          !groupRoles(groups) ||
          !strings(memberships) ||
          (item.email != null && typeof item.email !== 'string') ||
          (item.picture != null && typeof item.picture !== 'string')
        )
          return malformed(endpoint);
        return {
          id: item.id,
          username: item.username,
          method: item.method,
          email: typeof item.email === 'string' ? item.email : undefined,
          picture: typeof item.picture === 'string' ? item.picture : undefined,
          roles: item.roles,
          groupRoles: groups,
          userGroups: memberships,
        };
      });
    },
    createUser: (name, assigned) =>
      readText(user(name), jsonBody('POST', assigned), onUnauthorized),
    deleteUser: (id) => mutate(user(id), { method: 'DELETE' }),
    addUserRoles: (id, assigned) => mutate(`${user(id)}/role/add`, jsonBody('PATCH', assigned)),
    removeUserRoles: (id, assigned) =>
      mutate(`${user(id)}/role/remove`, jsonBody('PATCH', assigned)),
    resetPassword: (id) =>
      readText(`${user(id)}/generate-new-password`, { method: 'POST' }, onUnauthorized),
    async userRoleSources(id, signal) {
      const endpoint = `${user(id)}/role`;
      const data = await readJson(endpoint, { signal }, onUnauthorized);
      if (!object(data)) return malformed(endpoint);
      const normalized = { ...data, groupRoles: data.groupRoles ?? data.group_roles };
      if (!roleSources(normalized)) return malformed(endpoint);
      return normalized;
    },
    async listRoles(signal) {
      const endpoint = `${base}/roles`;
      const data = await readJson(endpoint, { signal }, onUnauthorized);
      if (!roles(data)) return malformed(endpoint);
      return data;
    },
    async putRole(name, actions) {
      await mutate(role(name), jsonBody('PUT', actions));
    },
    async deleteRole(name) {
      await mutate(role(name), { method: 'DELETE' });
    },
    async defaultRole(signal) {
      const endpoint = `${base}/role/default`;
      const data = await readJson(endpoint, { signal }, onUnauthorized);
      if (data !== null && typeof data !== 'string') return malformed(endpoint);
      return data;
    },
    setDefaultRole: (name) => mutate(`${base}/role/default`, jsonBody('PUT', name)),
    clearDefaultRole: () => mutate(`${base}/role/default`, { method: 'DELETE' }),
    async listApiKeys(signal) {
      const data = await readJson(keys, { signal }, onUnauthorized);
      if (!Array.isArray(data) || !data.every(apiKey)) return malformed(keys);
      return data;
    },
    async createApiKey(keyName, assigned) {
      const data = await readJson(
        keys,
        jsonBody('POST', { keyName, roles: assigned }),
        onUnauthorized,
      );
      if (!apiKey(data)) return malformed(keys);
      return data;
    },
    async getApiKey(id, signal) {
      const endpoint = `${keys}/${encodeURIComponent(id)}`;
      const data = await readJson(endpoint, { signal }, onUnauthorized);
      if (!apiKey(data)) return malformed(endpoint);
      return data;
    },
    deleteApiKey: (id) => mutate(`${keys}/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    async listDatasets(signal) {
      const endpoint = `${base}/logstream`;
      const data = await readJson(endpoint, { signal }, onUnauthorized);
      if (
        !Array.isArray(data) ||
        !data.every((item) => object(item) && typeof item.name === 'string')
      )
        return malformed(endpoint);
      // This endpoint returns names only. Do not infer telemetry type from a name.
      return data.map((item) => ({ name: item.name, type: 'logs' }) satisfies Dataset);
    },
    async schema(dataset, signal) {
      const endpoint = `${base}/logstream/${encodeURIComponent(dataset)}/schema`;
      const data = await readJson(endpoint, { signal }, onUnauthorized);
      if (
        !object(data) ||
        !Array.isArray(data.fields) ||
        !data.fields.every((field) => object(field) && typeof field.name === 'string')
      )
        return malformed(endpoint);
      return data.fields.map((field) => field.name as string);
    },
    async query({ sql, startTime, endTime }, signal) {
      const endpoint = `${base}/query`;
      const data = await readJson(
        endpoint,
        {
          method: 'POST',
          signal,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: sql, startTime, endTime, sendNull: true }),
        },
        onUnauthorized,
      );
      if (!Array.isArray(data) || !data.every(object)) return malformed(endpoint);
      return data as LogRecord[];
    },
    async identity(signal) {
      const fallback = cookieIdentity();
      if (!fallback) return undefined;
      const endpoint = `${base}/users/${encodeURIComponent(fallback.id)}`;
      try {
        const data = await readJson(endpoint, { signal }, onUnauthorized);
        if (!object(data) || typeof data.id !== 'string' || typeof data.username !== 'string')
          return malformed(endpoint);
        return {
          id: data.id,
          username: data.username,
          method: typeof data.method === 'string' ? data.method : undefined,
          email: typeof data.email === 'string' ? data.email : undefined,
          source: 'server',
        };
      } catch (error) {
        if (signal?.aborted || (error instanceof ApiError && error.status === 401)) throw error;
        // Identity hints are display-only; a missing/unavailable profile must not
        // make the workspace unusable or grant access to protected requests.
        return fallback;
      }
    },
    async login(username, password, returnPath = '/') {
      if (!username || username.includes(':'))
        throw new ApiError('Enter a username without a colon', 400);
      const bytes = new TextEncoder().encode(`${username}:${password}`);
      const credentials = btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(''));
      await checked(
        await fetch(authEndpoint('login', returnPath), {
          credentials: 'include',
          headers: { Authorization: `Basic ${credentials}` },
          redirect: 'follow',
        }),
      );
      // Verify the exchanged cookie independently; never persist the password or
      // resend Basic auth with data requests.
      try {
        await readJson(`${base}/logstream`, {});
      } catch (error) {
        // A restricted account may sign in successfully without stream-list access.
        if (!(error instanceof ApiError && error.status === 403)) throw error;
      }
    },
    async logout() {
      // OIDC logout can cross origins; a fetch cannot complete that browser flow.
      window.location.assign(authEndpoint('logout', '/login'));
    },
  };
}
