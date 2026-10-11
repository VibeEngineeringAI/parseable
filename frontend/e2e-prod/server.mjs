// Serves the production build in `dist-e2e` the way Parseable embeds it: at `/`,
// and under `/next` with `<base href="/">` pointed at the mount, as `mount_ui`
// does with P_UI_ROOT=classic. Paths that are not files get `index.html`,
// except missing hashed assets, which stay a 404.
import { createServer } from 'node:http';
import { readdir, readFile } from 'node:fs/promises';
import { extname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = fileURLToPath(new URL('../dist-e2e/', import.meta.url));
const port = Number(process.env.PORT || 4180);
const types = {
  '.css': 'text/css',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

const files = new Map();
for (const entry of await readdir(dist, { recursive: true, withFileTypes: true })) {
  if (!entry.isFile()) continue;
  const path = join(entry.parentPath, entry.name);
  files.set(relative(dist, path).split(sep).join('/'), await readFile(path));
}
const index = files.get('index.html').toString();
if (!index.includes('<base href="/"'))
  throw new Error('dist-e2e/index.html has no <base href="/">');

createServer((req, res) => {
  const { pathname } = new URL(req.url ?? '/', 'http://localhost');
  const mount = pathname === '/next' || pathname.startsWith('/next/') ? '/next' : '';
  const path = decodeURIComponent(pathname.slice(mount.length)).replace(/^\/+/, '');
  const file = files.get(path);
  if (file) {
    res.writeHead(200, { 'content-type': types[extname(path)] ?? 'application/octet-stream' });
    res.end(file);
  } else if (path.startsWith('assets/')) {
    res.writeHead(404).end();
  } else {
    res.writeHead(200, { 'content-type': types['.html'] });
    res.end(index.replace('<base href="/"', `<base href="${mount}/"`));
  }
}).listen(port, '127.0.0.1');
