#!/usr/bin/env node
// Posts a gh-comment report as the comment-clanker GitHub App.
//
// Run through the swamp `post-pr-review` workflow, which supplies the App
// credentials from the `comment-clanker` vault:
//   GH_APP_CLIENT_ID, GH_APP_PRIVATE_KEY   App identity (required)
//   CLANKER_PR                             PR number or URL (required)
//   CLANKER_REPORT                         gh-comment Markdown report (required)
//   CLANKER_REPO                           OWNER/REPO (default: VibeEngineeringAI/parseable)
//   CLANKER_CWD                            checkout for source links (default: repo root)
//   CLANKER_DRY_RUN                        "true" to plan without publishing
//   CLANKER_ALLOW_CONVERSATION_COMMENTS    "true" to allow non-resolvable comments
//
// The installation token is scoped to one repository and pull_requests:write,
// is never printed, and is revoked once gh-comment exits.
import { createSign } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { assertResolvableComments } from './comment-clanker-policy.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const api = 'https://api.github.com';
const execFileAsync = promisify(execFile);

function commentEnvironment(token) {
  return { ...process.env, GH_TOKEN: token, GH_APP_PRIVATE_KEY: '' };
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

// GitHub accepts the App's client ID as the JWT issuer.
function appJwt(clientId, privateKey) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: clientId }));
  const signature = createSign('RSA-SHA256').update(`${header}.${payload}`).sign(privateKey, 'base64url');
  return `${header}.${payload}.${signature}`;
}

async function github(method, path, token, body) {
  const response = await fetch(`${api}${path}`, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: body && JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`GitHub ${method} ${path} failed: HTTP ${response.status} ${await response.text()}`);
  }
  return response.status === 204 ? undefined : response.json();
}

async function installationToken(clientId, privateKey, repository) {
  const jwt = appJwt(clientId, privateKey);
  const [owner, repo] = repository.split('/');
  const installation = await github('GET', `/repos/${owner}/${repo}/installation`, jwt);
  const { token } = await github('POST', `/app/installations/${installation.id}/access_tokens`, jwt, {
    repositories: [repo],
    permissions: { pull_requests: 'write' },
  });
  return token;
}

function ghComment(args, token) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.env.GH_COMMENT_BIN || 'gh-comment', args, {
      env: commentEnvironment(token),
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('close', (code, signal) => resolvePromise(code ?? (signal ? 1 : 0)));
  });
}

async function main() {
  const clientId = required('GH_APP_CLIENT_ID');
  const privateKey = required('GH_APP_PRIVATE_KEY');
  const pr = required('CLANKER_PR');
  const repository = process.env.CLANKER_REPO?.trim() || 'VibeEngineeringAI/parseable';
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error(`CLANKER_REPO must be OWNER/REPO, got: ${repository}`);
  }
  const cwd = resolve(process.env.CLANKER_CWD?.trim() || repoRoot);
  const report = resolve(cwd, required('CLANKER_REPORT'));
  const dryRun = process.env.CLANKER_DRY_RUN?.trim() === 'true';

  const token = await installationToken(clientId, privateKey, repository);
  try {
    const target = [report, '--repo', repository, '--pr', pr, '--cwd', cwd];
    // Render validates report syntax and PR anchors without publishing. Inspect
    // parsed entry kinds so a source link alone cannot masquerade as a thread.
    const { stdout } = await execFileAsync(
      process.env.GH_COMMENT_BIN || 'gh-comment',
      ['render', ...target, '--json'],
      { env: commentEnvironment(token), maxBuffer: 8 * 1024 * 1024 },
    );
    assertResolvableComments(
      JSON.parse(stdout),
      process.env.CLANKER_ALLOW_CONVERSATION_COMMENTS?.trim() === 'true',
    );
    const args = ['post', ...target];
    if (dryRun) args.push('--dry-run');
    process.exitCode = await ghComment(args, token);
  } finally {
    await github('DELETE', '/installation/token', token).catch(error => {
      process.stderr.write(`Could not revoke the installation token (it expires within an hour): ${error.message}\n`);
    });
  }
}

main().catch(error => {
  process.stderr.write(`comment-clanker: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
