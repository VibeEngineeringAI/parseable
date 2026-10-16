#!/usr/bin/env python3
"""Live saved-filter conversion/restart regression using an isolated local-store.

Run: PARSEABLE_BIN=/absolute/path/to/parseable python3 scripts/test-sql-filter-conversion.py
No existing server, data directory, credentials, or Parseable environment is used.
"""
import base64
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
import uuid


def free_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


def main():
    binary = Path(os.environ['PARSEABLE_BIN']).expanduser().resolve()
    if not binary.is_file() or not os.access(binary, os.X_OK):
        raise RuntimeError('PARSEABLE_BIN must point to an executable server')
    with tempfile.TemporaryDirectory(prefix='parseable-filter-smoke-') as directory:
        root = Path(directory)
        ports = set()
        while len(ports) < 4:
            ports.add(free_port())
        http_port, grpc_port, flight_port, query_port = ports
        url = f'http://127.0.0.1:{http_port}'
        admin = ('filter-smoke-admin', uuid.uuid4().hex)
        env = {
            'PATH': os.environ.get('PATH', '/usr/bin:/bin'),
            'P_ADDR': f'127.0.0.1:{http_port}',
            'P_GRPC_PORT': str(grpc_port), 'P_FLIGHT_PORT': str(flight_port),
            'P_QUERY_GRPC_PORT': str(query_port),
            'P_USERNAME': admin[0], 'P_PASSWORD': admin[1],
            'P_FS_DIR': str(root / 'data'), 'P_STAGING_DIR': str(root / 'staging'),
            'P_CHECK_UPDATE': 'false', 'P_SEND_ANONYMOUS_USAGE_DATA': 'false',
            'P_ACTIX_NUM_WORKERS': '2',
        }
        process = None
        log = (root / 'server.log').open('wb')

        def request(method, path, body=None, auth=admin, expected=200):
            headers = {'Accept': 'application/json'}
            if auth is not None:
                token = base64.b64encode(f'{auth[0]}:{auth[1]}'.encode()).decode()
                headers['Authorization'] = f'Basic {token}'
            data = None
            if body is not None:
                data = json.dumps(body).encode()
                headers['Content-Type'] = 'application/json'
            req = urllib.request.Request(url + path, data=data, headers=headers, method=method)
            try:
                with urllib.request.urlopen(req, timeout=15) as response:
                    status, raw = response.status, response.read()
            except urllib.error.HTTPError as error:
                status, raw = error.code, error.read()
            if expected is None:
                assert status >= 400, f'{method} {path}: expected denial, got {status}'
                return None
            assert status == expected, f'{method} {path}: expected {expected}, got {status}: {raw[:500]!r}'
            try:
                return json.loads(raw) if raw else None
            except json.JSONDecodeError:
                return raw.decode()

        def stop():
            nonlocal process
            if process is not None:
                process.terminate()
                try:
                    process.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)
                process = None

        def start():
            nonlocal process
            process = subprocess.Popen([str(binary), 'local-store'], cwd=root, env=env,
                                       stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT)
            deadline = time.monotonic() + 45
            while time.monotonic() < deadline:
                if process.poll() is not None:
                    raise RuntimeError('Disposable server exited during startup')
                try:
                    request('GET', '/api/v1/liveness')
                    return
                except (urllib.error.URLError, TimeoutError):
                    time.sleep(0.2)
            raise RuntimeError('Disposable server did not become ready')

        try:
            start()
            dataset = 'filter_smoke_logs'
            request('PUT', f'/api/v1/logstream/{dataset}', {})
            request('PUT', '/api/v1/role/filter-smoke-reader', {
                'roleType': 'user',
                'actions': [{'privilege': 'reader', 'resource': {'stream': dataset}}],
            })
            owner = ('filter-owner', request('POST', '/api/v1/user/filter-owner', ['filter-smoke-reader']))
            other = ('filter-other', request('POST', '/api/v1/user/filter-other', ['filter-smoke-reader']))
            body = {
                'stream_name': dataset, 'filter_name': 'Incident view',
                'query': {'filter_type': 'sql', 'filter_query': f'SELECT * FROM {dataset}', 'filter_builder': None},
                'time_filter': None,
                'explorer_state': 'preserve-this-native-state', 'labels': ['incident'],
            }
            legacy = request('POST', '/api/v1/filters', body, auth=owner)
            assert legacy['stream_name'] == dataset
            # Creating a fresh ID must not enumerate other dataset directories.
            # An unreadable sibling is unrelated to this new saved view.
            legacy_files = list((root / 'data').rglob(f"{legacy['filter_id']}.json"))
            assert len(legacy_files) == 1
            blocked = legacy_files[0].parent.parent / 'unreadable_sibling'
            blocked.mkdir()
            blocked.chmod(0)
            try:
                before = set((blocked.parent / dataset).glob('*.json'))
                try:
                    created = request('POST', '/api/v1/filters', {
                        **body, 'filter_name': 'Create beside unreadable directory',
                    }, auth=owner)
                except AssertionError as error:
                    persisted = set((blocked.parent / dataset).glob('*.json')) - before
                    raise AssertionError(
                        f'New-filter POST failed after persisting {len(persisted)} new record(s): {error}'
                    ) from error
                assert created['filter_name'] == 'Create beside unreadable directory'
                assert len(set((blocked.parent / dataset).glob('*.json')) - before) == 1
            finally:
                blocked.chmod(0o755)
                blocked.rmdir()
            identifier = legacy['filter_id']
            path = f'/api/v1/filters/{identifier}'
            request('POST', path + '/convert-to-sql', auth=other, expected=None)
            request('POST', path + '/convert-to-sql', auth=None, expected=None)
            # Admin editing must not move the record into the admin's directory.
            edited = request('PUT', path, {**legacy, 'filter_name': 'Admin edit'})
            assert edited['user_id'] == legacy['user_id']
            converted = request('POST', path + '/convert-to-sql', auth=owner)
            assert converted == {**edited, 'stream_name': 'sql'}
            assert request('POST', path + '/convert-to-sql', auth=owner) == converted
            # A stale client must not undo conversion on a normal edit.
            updated = request('PUT', path, {**edited, 'filter_name': 'After conversion'}, auth=owner)
            assert updated['stream_name'] == 'sql'
            assert updated['user_id'] == legacy['user_id']
            assert updated['explorer_state'] == body['explorer_state']
            assert any(view['filter_id'] == identifier for view in request('GET', '/api/v1/filters', auth=owner))
            request('POST', '/api/v1/filters', {**body, 'stream_name': '../../bad'}, auth=owner, expected=None)
            classic = request('POST', '/api/v1/filters', {**body, 'query': {**body['query'], 'filter_type': 'search'}}, auth=owner)
            request('POST', f"/api/v1/filters/{classic['filter_id']}/convert-to-sql", auth=owner, expected=None)
            stop()
            files = list((root / 'data').rglob(f'{identifier}.json'))
            assert len(files) == 1 and files[0].parent.name == 'sql'
            # Emulate a canonical write that crashed before removing the old copy.
            stale = files[0].parent.parent / dataset / files[0].name
            stale.parent.mkdir(parents=True, exist_ok=True)
            stale.write_text(json.dumps(legacy))
            start()
            assert request('GET', path, auth=owner)['filter_name'] == 'After conversion'
            assert not stale.exists(), 'Startup must reconcile the obsolete copy'
            request('DELETE', path, auth=owner)
            stop()
            start()
            assert all(view['filter_id'] != identifier for view in request('GET', '/api/v1/filters', auth=owner))
            assert not list((root / 'data').rglob(f'{identifier}.json'))
            print('PASS: live legacy/create, create with unreadable sibling, owner authorization, admin ownership, conversion/retry, stale update, restart reconciliation, deletion/restart')
        finally:
            stop()
            log.close()


if __name__ == '__main__':
    main()
