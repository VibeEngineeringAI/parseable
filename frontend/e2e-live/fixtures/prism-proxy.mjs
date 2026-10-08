// Read-only original Prism assets + same-origin API proxy for visual comparison.
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve, extname, sep } from 'node:path';

const root = resolve(
  process.env.PRISM_ASSETS || `${homedir()}/.local/share/prism-ui-research/v3.2.4/extracted/dist`,
);
const port = Number(process.env.PRISM_PORT || 8260);
const backend = new URL(process.env.PARSEABLE_PROXY_TARGET || 'http://127.0.0.1:8250');
const mime = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};
const server = http.createServer(async (request, response) => {
  if (request.url === '/api' || request.url.startsWith('/api/')) {
    const upstream = http.request(
      {
        hostname: backend.hostname,
        port: backend.port,
        path: request.url,
        method: request.method,
        headers: request.headers,
      },
      (result) => {
        response.writeHead(result.statusCode, result.headers);
        result.pipe(response);
      },
    );
    upstream.on('error', () => {
      response.writeHead(502);
      response.end('Local Parseable unavailable');
    });
    request.pipe(upstream);
    return;
  }
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    let file = resolve(root, `.${pathname}`);
    if (!file.startsWith(`${root}${sep}`) && file !== root) {
      response.writeHead(403);
      response.end();
      return;
    }
    if (!(await stat(file).catch(() => undefined))?.isFile()) file = resolve(root, 'index.html');
    const content = await readFile(file);
    response.writeHead(200, { 'Content-Type': mime[extname(file)] || 'application/octet-stream' });
    response.end(content);
  } catch {
    response.writeHead(500);
    response.end('Could not read Prism assets');
  }
});
server.listen(port, '127.0.0.1', () => console.log(`Prism reference: http://127.0.0.1:${port}`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close());
