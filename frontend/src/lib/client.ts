import { createDemoClient } from './demo';
import { authEndpoint, cookieIdentity } from './auth';
import { demoEnabled } from './config';
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

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
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
      object(detail) && typeof detail.message === 'string'
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
  const received = await fetch(endpoint, { ...init, credentials: 'include' });
  if (received.status === 401) onUnauthorized?.();
  const response = await checked(received);
  try {
    return await response.json();
  } catch {
    return malformed(endpoint);
  }
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
  return {
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
