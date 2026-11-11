"""Test-only HTTP fault proxy; writes bypass this proxy and go directly to MinIO."""
import http.client
import http.server
import pathlib
import sys
import urllib.parse

upstream = urllib.parse.urlsplit(sys.argv[1])
mode_file = pathlib.Path(sys.argv[2])

class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *_):
        pass

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        mode = mode_file.read_text()
        with mode_file.with_suffix('.requests').open('a') as log:
            log.write(str(bool(self.headers.get('If-None-Match'))) + '\n')
        if mode == 'fail' and self.headers.get('If-None-Match'):
            self.send_response(503)
            self.send_header('Content-Length', '0')
            self.end_headers()
            return
        headers = {key.lower(): value for key, value in self.headers.items()}
        full = mode == 'full' and self.headers.get('Range') == 'bytes=0-262144'
        conn = http.client.HTTPConnection(upstream.hostname, upstream.port, timeout=10)
        conn.request(self.command, self.path, headers=headers)
        response = conn.getresponse()
        body = response.read()
        self.send_response(200 if full and response.status == 206 else response.status)
        for key, value in response.getheaders():
            if key.lower() in ('connection', 'transfer-encoding') or (full and key.lower() == 'content-range'):
                continue
            if key.lower() == 'etag':
                if mode == 'absent':
                    continue
                if mode == 'weak':
                    value = 'W/' + value
            self.send_header(key, value)
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(body[:len(body)//2] if mode == 'broken' else body)
        if mode == 'broken':
            self.close_connection = True
        conn.close()

server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
print(server.server_port, flush=True)
server.serve_forever()
