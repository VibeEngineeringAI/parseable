// A loopback-only OIDC fixture for real Parseable integration tests. Never deploy it.
// Uses real discovery, one-use codes, RS256 ID tokens, JWKS and userinfo.
import http from 'node:http';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';

const port = Number(process.env.MOCK_OIDC_PORT || 8251);
const issuer = `http://127.0.0.1:${port}`;
const clientId = process.env.MOCK_OIDC_CLIENT_ID || 'frontend-smoke';
const clientSecret = process.env.MOCK_OIDC_CLIENT_SECRET || 'local-fixture-secret';
const callback = process.env.MOCK_OIDC_REDIRECT_URI || 'http://127.0.0.1:8270/api/v1/o/code';
const frontendOrigin = new URL(callback).origin;
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const kid = randomUUID();
const jwk = { ...publicKey.export({ format: 'jwk' }), kid, use: 'sig', alg: 'RS256' };
const pending = new Map();
const codes = new Map();
const tokens = new Map();
const user = {
  sub: 'frontend-smoke-sso',
  name: 'Smoke SSO User',
  preferred_username: 'smoke-sso',
  email: 'smoke-sso@example.test',
  email_verified: true,
  groups: ['frontend-smoke-reader'],
};
const json = (response, status, value) => {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(value));
};
const redirect = (response, url) => {
  response.writeHead(302, { Location: url, 'Cache-Control': 'no-store' });
  response.end();
};
async function form(request) {
  let body = '';
  for await (const part of request) {
    body += part;
    if (body.length > 16_384) throw new Error('Request too large');
  }
  return new URLSearchParams(body);
}
function jwt(claims) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = `${encode({ alg: 'RS256', kid, typ: 'JWT' })}.${encode(claims)}`;
  return `${unsigned}.${sign('RSA-SHA256', Buffer.from(unsigned), privateKey).toString('base64url')}`;
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, issuer);
    if (url.pathname === '/.well-known/openid-configuration') {
      return json(response, 200, {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        userinfo_endpoint: `${issuer}/userinfo`,
        jwks_uri: `${issuer}/jwks`,
        end_session_endpoint: `${issuer}/logout`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
        scopes_supported: ['openid', 'profile', 'email'],
        claims_supported: Object.keys(user),
        grant_types_supported: ['authorization_code'],
      });
    }
    if (url.pathname === '/jwks') return json(response, 200, { keys: [jwk] });
    if (url.pathname === '/authorize') {
      if (
        url.searchParams.get('client_id') !== clientId ||
        url.searchParams.get('redirect_uri') !== callback ||
        url.searchParams.get('response_type') !== 'code'
      ) {
        return json(response, 400, { error: 'invalid_request' });
      }
      const ticket = randomUUID();
      pending.set(ticket, { params: url.searchParams, expires: Date.now() + 60_000 });
      response.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
      return response.end(
        `<!doctype html><html lang="en"><meta charset="utf-8"><title>Local mock identity provider</title><body><main><h1>Local mock identity provider</h1><p>Sign in as Smoke SSO User for the Parseable live smoke test.</p><form method="post" action="/approve"><input type="hidden" name="ticket" value="${ticket}"><button type="submit">Sign in as Smoke SSO User</button></form></main></body></html>`,
      );
    }
    if (url.pathname === '/approve' && request.method === 'POST') {
      const body = await form(request);
      const ticket = body.get('ticket');
      const authorization = pending.get(ticket);
      pending.delete(ticket);
      if (!authorization || authorization.expires < Date.now())
        return json(response, 400, { error: 'expired_authorization' });
      const code = randomUUID();
      codes.set(code, authorization);
      const target = new URL(callback);
      target.searchParams.set('code', code);
      target.searchParams.set('state', authorization.params.get('state') || '');
      return redirect(response, target.href);
    }
    if (url.pathname === '/token' && request.method === 'POST') {
      const body = await form(request);
      const basic = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`;
      if (
        request.headers.authorization !== basic &&
        !(body.get('client_id') === clientId && body.get('client_secret') === clientSecret)
      )
        return json(response, 401, { error: 'invalid_client' });
      const authorization = codes.get(body.get('code'));
      codes.delete(body.get('code'));
      if (
        body.get('grant_type') !== 'authorization_code' ||
        body.get('redirect_uri') !== callback ||
        !authorization ||
        authorization.expires < Date.now()
      )
        return json(response, 400, { error: 'invalid_grant' });
      const accessToken = randomUUID();
      const now = Math.floor(Date.now() / 1000);
      tokens.set(accessToken, now + 600);
      const nonce = authorization.params.get('nonce');
      return json(response, 200, {
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: 600,
        scope: 'openid profile email',
        id_token: jwt({
          iss: issuer,
          aud: clientId,
          iat: now,
          exp: now + 600,
          ...user,
          ...(nonce ? { nonce } : {}),
        }),
      });
    }
    if (url.pathname === '/userinfo') {
      const accessToken = request.headers.authorization?.replace(/^Bearer /i, '');
      if ((tokens.get(accessToken) || 0) < Date.now() / 1000)
        return json(response, 401, { error: 'invalid_token' });
      return json(response, 200, user);
    }
    if (url.pathname === '/logout') {
      const target = new URL(
        url.searchParams.get('post_logout_redirect_uri') || '/',
        frontendOrigin,
      );
      if (target.origin !== frontendOrigin)
        return json(response, 400, { error: 'invalid_redirect' });
      return redirect(response, target.href);
    }
    return json(response, 404, { error: 'not_found' });
  } catch (error) {
    console.error(error.message);
    if (!response.headersSent) json(response, 400, { error: 'invalid_request' });
    else response.end();
  }
});
server.listen(port, '127.0.0.1', () =>
  console.log(`Local OIDC fixture: ${issuer}; callback ${callback}`),
);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close());
