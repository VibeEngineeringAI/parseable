// Own every process and byte served: never attach to a developer or production server.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const frontend = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repository = resolve(frontend, '..');
if (process.argv.includes('--help')) {
  console.log(`Usage: npm run test:keystone-native [-- --help]
Requires Node >=22.12, npm ci, the repository Rust toolchain, and Playwright Chromium.
Install Chromium explicitly with: npx playwright install chromium
Linux/macOS only. Builds this frontend and Rust harness; uses fresh loopback ports/storage.
Optional: TMPDIR, CARGO_TARGET_DIR, PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
KEYSTONE_NATIVE_ARTIFACTS (parent directory for retained per-run logs and reports).
No credentials or real provider calls. No external server URL is accepted.`);
  process.exit(0);
}
if (process.platform === 'win32')
  throw new Error('This process-group launcher supports Linux/macOS only.');
const id = randomUUID();
const artifacts = join(
  resolve(process.env.KEYSTONE_NATIVE_ARTIFACTS || join(frontend, 'test-results/keystone-native')),
  id,
);
await mkdir(artifacts, { recursive: true });
console.log(`Native browser artifacts: ${artifacts}`);
const runtime = await mkdtemp(join(tmpdir(), 'keystone-native-'));
// Keep group ownership after a leader exits, so grandchildren are still cleaned.
const children = new Set();
const childEnv = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) =>
      [
        'PATH',
        'HOME',
        'TMPDIR',
        'LANG',
        'LC_ALL',
        'CARGO_HOME',
        'RUSTUP_HOME',
        'RUSTUP_TOOLCHAIN',
        'RUSTC',
        'RUSTFLAGS',
        'RUSTDOCFLAGS',
        'CC',
        'CXX',
        'AR',
        'PKG_CONFIG_PATH',
        'CFLAGS',
        'CXXFLAGS',
        'LDFLAGS',
        'RUSTC_WRAPPER',
        'CMAKE',
        'CMAKE_GENERATOR',
        'SDKROOT',
        'DEVELOPER_DIR',
        'MACOSX_DEPLOYMENT_TARGET',
        'HTTP_PROXY',
        'HTTPS_PROXY',
        'ALL_PROXY',
        'NO_PROXY',
        'http_proxy',
        'https_proxy',
        'all_proxy',
        'no_proxy',
        'SSL_CERT_FILE',
        'SSL_CERT_DIR',
        'PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH',
        'PLAYWRIGHT_BROWSERS_PATH',
      ].includes(key) || key.startsWith('CARGO_'),
  ),
);
childEnv.VITE_ENABLE_DEMO = 'false';
// Proxy policies must never send our synthetic loopback traffic off this machine.
childEnv.NO_PROXY = `${childEnv.NO_PROXY || ''},127.0.0.1,localhost,::1`;
childEnv.no_proxy = `${childEnv.no_proxy || ''},127.0.0.1,localhost,::1`;
let server;
let interrupted = false;
const stop = (child, signal = 'SIGTERM') => {
  if (child.pid) {
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  }
};
let interruptionTimer;
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'])
  process.on(signal, () => {
    interrupted = true;
    for (const child of children) stop(child);
    interruptionTimer ??= setTimeout(() => {
      for (const child of children) stop(child, 'SIGKILL');
    }, 3000);
  });
function launch(label, command, args, options = {}) {
  if (interrupted) throw new Error('Interrupted');
  console.log(`Stage: ${label}`);
  const output = createWriteStream(join(artifacts, `${label}.log`));
  const child = spawn(command, args, {
    cwd: frontend,
    env: childEnv,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
  children.add(child);
  child.stdout.pipe(output, { end: false });
  child.stderr.pipe(output, { end: false });
  if (label === 'browser') child.stdout.pipe(process.stdout, { end: false });
  const started = Date.now();
  const progress = setInterval(
    () =>
      console.log(
        `Stage: ${label} (${Math.round((Date.now() - started) / 1000)}s); ${join(artifacts, `${label}.log`)}`,
      ),
    30_000,
  );
  const done = new Promise((resolveDone, reject) => {
    child.once('error', (error) => {
      clearInterval(progress);
      output.end();
      reject(
        new Error(
          `${label}: ${error.message}. Check prerequisites with npm run test:keystone-native -- --help`,
        ),
      );
    });
    child.once('close', (code, signal) => {
      clearInterval(progress);
      output.end();
      if (code === 0) resolveDone();
      else
        reject(
          new Error(`${label} exited ${signal || code}; see ${join(artifacts, `${label}.log`)}`),
        );
    });
  });
  // Servers can fail before readiness; preserve the rejection for the awaited lifecycle.
  done.catch(() => {});
  return { child, done };
}
async function run(label, command, args, options) {
  await launch(label, command, args, options).done;
}
async function waitReady(path, processDone) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (interrupted) throw new Error('Interrupted');
    try {
      return JSON.parse(await readFile(path, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await Promise.race([
      new Promise((r) => setTimeout(r, 100)),
      processDone.then(() => {
        throw new Error('Harness exited before readiness');
      }),
    ]);
  }
  throw new Error('Harness did not publish readiness within 30 seconds; see harness.log');
}
try {
  const { chromium } = await import('@playwright/test').catch(() => {
    throw new Error('Frontend dependencies missing: run npm ci from frontend first.');
  });
  await access(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || chromium.executablePath()).catch(
    () => {
      throw new Error(
        'Chromium missing: run npx playwright install chromium, or set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH.',
      );
    },
  );
  await run('rust-preflight', 'cargo', ['--version'], { cwd: repository });
  await run('frontend-typecheck', process.execPath, [
    'node_modules/typescript/bin/tsc',
    '--noEmit',
  ]);
  const build = join(runtime, 'build');
  await run('frontend-build', process.execPath, [
    'node_modules/vite/bin/vite.js',
    'build',
    '--base=/',
    '--outDir',
    build,
  ]);
  const classic = join(runtime, 'classic');
  await mkdir(classic);
  await writeFile(
    join(classic, 'index.html'),
    '<!doctype html><title>Classic UI excluded from native fixture</title>',
  );
  const cargo = launch(
    'rust-build',
    'cargo',
    ['test', '--locked', '--lib', '--no-run', '--message-format=json'],
    { cwd: repository, env: { ...childEnv, LOCAL_ASSETS_PATH: classic, NEXT_ASSETS_PATH: build } },
  );
  cargo.child.stdout.setEncoding('utf8');
  let buffer = '';
  let executable;
  cargo.child.stdout.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      try {
        const message = JSON.parse(line);
        if (
          message.reason === 'compiler-artifact' &&
          message.target.name === 'parseable' &&
          message.target.kind.includes('lib') &&
          message.profile.test &&
          message.executable
        )
          executable = message.executable;
      } catch {
        /* Cargo diagnostics are retained verbatim. */
      }
    }
  });
  await cargo.done;
  if (!executable) throw new Error('Cargo did not report the parseable library test executable.');
  const readyFile = join(runtime, 'ready.json');
  const harness = launch(
    'harness',
    executable,
    [
      'keystone::api::live_tests::native_browser_diagnostic_server',
      '--ignored',
      '--exact',
      '--nocapture',
    ],
    {
      cwd: repository,
      env: {
        ...childEnv,
        TMPDIR: runtime,
        KEYSTONE_DIAGNOSTIC_PORT: '0',
        KEYSTONE_DIAGNOSTIC_DIRECTORY: join(runtime, 'repository'),
        KEYSTONE_DIAGNOSTIC_ID: id,
        KEYSTONE_DIAGNOSTIC_READY_FILE: readyFile,
        KEYSTONE_DIAGNOSTIC_SECONDS: '600',
      },
    },
  );
  const ready = await waitReady(readyFile, harness.done);
  if (ready.identity !== id) throw new Error('Harness readiness identity mismatch');
  const probe = await fetch(`${ready.url}/api/prism/v1/keystone/native/capabilities`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!probe.ok || probe.headers.get('x-keystone-native-fixture') !== id)
    throw new Error('Harness capabilities/identity readiness check failed');
  const types = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.svg': 'image/svg+xml',
    '.json': 'application/json',
    '.png': 'image/png',
    '.woff2': 'font/woff2',
  };
  server = createServer(async (incoming, outgoing) => {
    if (incoming.url.startsWith('/api/')) {
      const upstream = request(
        new URL(incoming.url, ready.url),
        { method: incoming.method, headers: incoming.headers },
        (response) => {
          outgoing.writeHead(response.statusCode, response.headers);
          response.pipe(outgoing);
        },
      );
      upstream.on('error', () => {
        if (!outgoing.headersSent) outgoing.writeHead(502);
        outgoing.end();
      });
      outgoing.on('close', () => upstream.destroy());
      incoming.pipe(upstream);
      return;
    }
    try {
      const pathname = decodeURIComponent(new URL(incoming.url, 'http://localhost').pathname);
      let path = resolve(build, `.${pathname}`);
      if (!path.startsWith(`${build}${sep}`)) path = join(build, 'index.html');
      try {
        if (!(await stat(path)).isFile()) path = join(build, 'index.html');
      } catch {
        path = join(build, 'index.html');
      }
      outgoing.writeHead(200, {
        'content-type': types[extname(path)] || 'application/octet-stream',
        'cache-control': 'no-store',
      });
      createReadStream(path).pipe(outgoing);
    } catch {
      outgoing.writeHead(400);
      outgoing.end();
    }
  });
  await new Promise((r, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', r);
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  await writeFile(
    join(artifacts, 'run.json'),
    JSON.stringify(
      { identity: id, frontend: url, harness: ready.url, executable, synthetic: true },
      null,
      2,
    ),
  );
  await Promise.race([
    run(
      'browser',
      process.execPath,
      ['node_modules/@playwright/test/cli.js', 'test', '-c', 'playwright.native.config.ts'],
      {
        env: {
          ...childEnv,
          KEYSTONE_NATIVE_URL: url,
          KEYSTONE_NATIVE_ID: id,
          KEYSTONE_NATIVE_RUN_ARTIFACTS: artifacts,
        },
      },
    ),
    harness.done.then(() => {
      throw new Error('Harness exited during browser checks');
    }),
  ]);
  console.log('Native browser checks passed.');
} catch (error) {
  console.error(error.message);
  console.error(`Inspect stage logs and Playwright artifacts: ${artifacts}`);
  process.exitCode = interrupted ? 130 : 1;
} finally {
  clearTimeout(interruptionTimer);
  const owned = [...children];
  for (const child of owned) stop(child);
  const deadline = Date.now() + 3000;
  while (owned.some((c) => c.exitCode === null && c.signalCode === null) && Date.now() < deadline)
    await new Promise((r) => setTimeout(r, 50));
  for (const child of owned) stop(child, 'SIGKILL');
  server?.closeAllConnections();
  if (server) await new Promise((r) => server.close(r));
  await rm(runtime, { recursive: true, force: true });
}
