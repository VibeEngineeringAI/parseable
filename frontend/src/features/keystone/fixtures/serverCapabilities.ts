// TEST AND STORY ONLY: capability bodies shaped like `src/keystone/api.rs` sends them,
// answered by a local fetcher so the real native decoder runs. Nothing leaves the page.
import { createNativeKeystonePageTransport } from '../../../lib/keystone/nativeTransport';
import type { KeystonePageTransport } from '../pageContract';

/**
 * - `default`: no `KEYSTONE_NATIVE_DIRECTORY`, so no repository or secret store.
 * - `degraded`: the repository stopped accepting writes after a failure.
 * - `ingest`: a node whose mode does not serve investigations.
 * - `legacy`: a server without Keystone, whose SPA fallback answers with HTML.
 * - `unauthorized` / `forbidden`: the auth middleware in front of every native route
 *   (`route.authorize(Action::Query)`) rejects the session with a plain-text 401 or 403.
 */
export type ServerCapabilityCase =
  'default' | 'degraded' | 'ingest' | 'legacy' | 'unauthorized' | 'forbidden';

/** Cases whose capability reads never reach a Keystone handler, so have no JSON body. */
type NoBodyCase = 'legacy' | 'unauthorized' | 'forbidden';

/** The middleware's plain-text rejection, as actix-web sends it. */
export function middlewareRejection(status: 401 | 403) {
  return new Response(status === 401 ? 'Unauthorized' : 'Forbidden', {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}

/** The `/capabilities` and `/ui/capabilities` bodies for a case with a JSON answer. */
export function serverCapabilityBodies(
  server: Exclude<ServerCapabilityCase, NoBodyCase>,
  manageProviders = true,
) {
  const mode = server === 'ingest' ? 'ingest' : 'all';
  const storage = server === 'degraded' ? 'degraded' : 'unavailable';
  // `ready` in api.rs needs a query-capable mode and a healthy repository.
  const ready = false;
  return {
    page: {
      schemaVersion: 1,
      mode,
      enabledModes: ['all', 'query'],
      disabled: mode !== 'all',
      storage,
      investigations: false,
      contextPolicy: 'direct_parent_v1',
      execution: 'unavailable',
      reason: server === 'degraded' ? 'provider_unconfigured' : 'secret_store_unavailable',
      generation: 'unconfigured',
      decisions: 'disabled',
      secretStore: server === 'degraded' ? 'ready' : 'unavailable',
      topology: 'single_local_coordinator',
      sharing: false,
      provider: null,
    },
    ui: {
      schemaVersion: 1,
      generative: { state: 'unconfigured', reason: 'provider_unconfigured' },
      tools: { state: 'unavailable', reason: 'tools_unavailable' },
      actions: { read: ready, run: ready, branch: ready, editLayout: ready, manageProviders },
    },
  };
}

/**
 * A fetcher answering only the two capability reads. Any other request fails, so a
 * page that tried to list or open investigations would show it in `calls`.
 */
export function serverCapabilityFetcher(server: ServerCapabilityCase, calls: string[] = []) {
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
  return async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    calls.push(url);
    if (server === 'legacy')
      return new Response('<!doctype html><html></html>', {
        headers: { 'Content-Type': 'text/html' },
      });
    if (server === 'unauthorized') return middlewareRejection(401);
    if (server === 'forbidden') return middlewareRejection(403);
    const bodies = serverCapabilityBodies(server);
    if (url.endsWith('/ui/capabilities')) return json(bodies.ui);
    if (url.endsWith('/capabilities')) return json(bodies.page);
    return new Response(JSON.stringify({ error: { code: 'fixture_unexpected_request' } }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  };
}

export function serverCapabilityTransport(
  server: ServerCapabilityCase,
  calls: string[] = [],
): KeystonePageTransport {
  return createNativeKeystonePageTransport(serverCapabilityFetcher(server, calls) as typeof fetch);
}
