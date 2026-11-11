#!/usr/bin/env python3
"""Isolated MinIO/PostgreSQL smoke and request-count comparison (no live services).
Run after P_BUILD_NO_UI=1 CARGO_BUILD_JOBS=4 cargo build.
Artifacts stay in .postgres-smoke/; all started processes/containers are removed.
"""
import atexit
import signal
import sys
import traceback
import base64
import datetime as dt
import json
import hashlib
import hmac
import xml.etree.ElementTree as ET
import os
from pathlib import Path
import socket
import subprocess as sp
import time
import urllib.request
import urllib.error

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / '.postgres-smoke'
OUT.mkdir(exist_ok=True)
ARCHIVE = OUT / 'runs'
ARCHIVE.mkdir(exist_ok=True)
if (OUT/'results.json').exists():
    previous = (OUT/'results.json').read_bytes()
    (ARCHIVE/(hashlib.sha256(previous).hexdigest()+'.json')).write_bytes(previous)
selection = os.environ.get('P_SMOKE_MODE', 'all')
assert selection in ['all', 'postgres', 'postgres-tls'], selection
modes = ['object-store', 'postgres-tls', 'postgres'] if selection == 'all' else [selection]
containers = []
server = None
auxiliary = None

commands = []
processes = []
results = {"requested_modes": modes}
http_requests = []
def run(*args):
    attempt = sp.run(args, text=True, stdout=sp.PIPE, stderr=sp.PIPE)
    commands.append(dict(argv=list(args), exit_code=attempt.returncode))
    attempt.check_returncode()
    return attempt.stdout.strip()

def postgres_logs(name):
    args = ['docker', 'logs', name]
    attempt = sp.run(args, text=True, stdout=sp.PIPE, stderr=sp.STDOUT)
    commands.append(dict(argv=args, exit_code=attempt.returncode))
    attempt.check_returncode()
    return attempt.stdout

def scalar(response, column, expected):
    value = json.loads(response)
    assert value == [{column: expected}], value
    return True

def wait_for_staging_drain(staging):
    quiet_since = None
    def drained():
        nonlocal quiet_since
        pending = any(p.is_file() and p.suffix in {'.arrow', '.arrows', '.part', '.parquet'}
                      for p in Path(staging).rglob('*'))
        if pending:
            quiet_since = None
            return False
        if quiet_since is None:
            quiet_since = time.monotonic()
        return time.monotonic() - quiet_since >= 2
    wait_for(drained, 300)

def cleanup():
    global auxiliary
    try:
        if auxiliary is not None:
            auxiliary.terminate()
            try:
                auxiliary.wait(timeout=15)
            except sp.TimeoutExpired:
                auxiliary.kill()
                auxiliary.wait()
            auxiliary = None
        stop()
    finally:
        for name in reversed(containers):
            attempt = sp.run(['docker', 'rm', '-f', name], stdout=sp.DEVNULL, stderr=sp.DEVNULL)
            commands.append(dict(argv=['docker', 'rm', '-f', name], exit_code=attempt.returncode))
        containers.clear()
        for process in processes:
            commands.append(dict(argv=process.args, exit_code=process.poll()))
        processes.clear()
        results['commands'] = commands
        results['success'] = sys.exc_info()[0] is None
        if sys.exc_info()[0] is not None:
            results['failure'] = traceback.format_exc()
        if (OUT/'checks.json').exists():
            results['validation'] = json.loads((OUT/'checks.json').read_text())
        results['http_requests'] = http_requests
        evidence = json.dumps(results, indent=2) + '\n'
        (OUT/'results.json').write_text(evidence)
        (ARCHIVE/(hashlib.sha256(evidence.encode()).hexdigest()+'.json')).write_text(evidence)
        runs = [json.loads(path.read_text()) for path in sorted(ARCHIVE.glob('*.json'))]
        (ROOT/'docs/validation/postgres-metastore-smoke.json').write_text(json.dumps({'runs': runs}, indent=2)+'\n')

def interrupted(signum, frame):
    raise SystemExit(128 + signum)
if globals().get('__name__') == '__main__':
    atexit.register(cleanup)
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)

def startup_attempt(environment, timeout):
    process = sp.Popen([str(Path(os.environ.get('CARGO_TARGET_DIR', ROOT/'target'))/'debug/parseable'), 's3-store'],
                       env=environment, cwd=ROOT, stdout=sp.PIPE, stderr=sp.STDOUT, text=True)
    processes.append(process)
    try:
        output, _ = process.communicate(timeout=timeout)
    except sp.TimeoutExpired:
        process.kill()
        process.communicate()
        raise
    return sp.CompletedProcess(process.args, process.returncode, output)

def port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]

def container(image, *args, **env):
    name = 'parseable-pg-smoke-' + str(os.getpid()) + '-' + str(len(containers))
    command = ['docker', 'run', '-d', '--name', name]
    for key, value in env.items():
        command += ['-e', f'{key}={value}']
    containers.append(name)
    return name, command

def list_keys(endpoint, bucket):
    """List real S3 keys with SigV4; no client package or image utilities needed."""
    now = dt.datetime.now(dt.timezone.utc)
    stamp, day = now.strftime('%Y%m%dT%H%M%SZ'), now.strftime('%Y%m%d')
    host = endpoint.removeprefix('http://')
    payload = hashlib.sha256(b'').hexdigest()
    headers = f'host:{host}\nx-amz-content-sha256:{payload}\nx-amz-date:{stamp}\n'
    signed = 'host;x-amz-content-sha256;x-amz-date'
    canonical = f'GET\n/{bucket}\nlist-type=2\n{headers}\n{signed}\n{payload}'
    scope = f'{day}/us-east-1/s3/aws4_request'
    message = f'AWS4-HMAC-SHA256\n{stamp}\n{scope}\n{hashlib.sha256(canonical.encode()).hexdigest()}'
    key = b'AWS4minioadmin'
    for value in [day, 'us-east-1', 's3', 'aws4_request']:
        key = hmac.new(key, value.encode(), hashlib.sha256).digest()
    signature = hmac.new(key, message.encode(), hashlib.sha256).hexdigest()
    authorization = f'AWS4-HMAC-SHA256 Credential=minioadmin/{scope}, SignedHeaders={signed}, Signature={signature}'
    req = urllib.request.Request(f'{endpoint}/{bucket}?list-type=2', headers={
        'Authorization': authorization, 'X-Amz-Date': stamp, 'X-Amz-Content-Sha256': payload})
    with urllib.request.urlopen(req, timeout=10) as response:
        root = ET.fromstring(response.read())
    assert root.findtext('{*}IsTruncated') != 'true', 'smoke fixture exceeded a listing page'
    return sorted(node.text for node in root.findall('{*}Contents/{*}Key'))

def get_key(endpoint, bucket, key, body=None):
    """Read publication documents with SigV4 without an SDK dependency."""
    now = dt.datetime.now(dt.timezone.utc)
    stamp, day = now.strftime('%Y%m%dT%H%M%SZ'), now.strftime('%Y%m%d')
    host = endpoint.removeprefix('http://')
    method = 'GET' if body is None else 'PUT'
    payload = hashlib.sha256(body or b'').hexdigest()
    headers = f'host:{host}\nx-amz-content-sha256:{payload}\nx-amz-date:{stamp}\n'
    signed = 'host;x-amz-content-sha256;x-amz-date'
    canonical = f'{method}\n/{bucket}/{key}\n\n{headers}\n{signed}\n{payload}'
    scope = f'{day}/us-east-1/s3/aws4_request'
    message = f'AWS4-HMAC-SHA256\n{stamp}\n{scope}\n{hashlib.sha256(canonical.encode()).hexdigest()}'
    signing_key = b'AWS4minioadmin'
    for value in [day, 'us-east-1', 's3', 'aws4_request']:
        signing_key = hmac.new(signing_key, value.encode(), hashlib.sha256).digest()
    signature = hmac.new(signing_key, message.encode(), hashlib.sha256).hexdigest()
    authorization = f'AWS4-HMAC-SHA256 Credential=minioadmin/{scope}, SignedHeaders={signed}, Signature={signature}'
    req = urllib.request.Request(f'{endpoint}/{bucket}/{key}', data=body, method=method, headers={
        'Authorization': authorization, 'X-Amz-Date': stamp, 'X-Amz-Content-Sha256': payload})
    with urllib.request.urlopen(req, timeout=10) as response:
        return response.read()

def stop():
    global server
    if server:
        server.terminate()
        try:
            server.wait(timeout=15)
        except sp.TimeoutExpired:
            server.kill()
            server.wait()
        server = None

def wait_for(check, seconds=180):
    deadline = time.monotonic() + seconds
    last_error = None
    while time.monotonic() < deadline:
        try:
            result = check()
            if result:
                return result
        except RuntimeError:
            raise
        except Exception as error:
            last_error = error
        time.sleep(1)
    raise RuntimeError('timed out waiting for smoke fixture') from last_error

try:
    pgport, s3port = port(), port()
    pg, cmd = container('postgres:17-alpine', POSTGRES_PASSWORD='smoke', POSTGRES_DB='parseable')
    run(*cmd, '-p', f'127.0.0.1:{pgport}:5432', 'postgres:17-alpine')
    mini, cmd = container('quay.io/parseablehq/minio:edge', MINIO_ROOT_USER='minioadmin', MINIO_ROOT_PASSWORD='minioadmin')
    run(*cmd, '-p', f'127.0.0.1:{s3port}:9000', 'quay.io/parseablehq/minio:edge', 'server', '/data')
    wait_for(lambda: 'accepting connections' in run('docker', 'exec', pg, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres'))
    # An isolated CA and signed localhost server certificate; no host config changes.
    tls = OUT / 'tls'
    tls.mkdir(exist_ok=True)
    run('openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', str(tls/'ca.key'), '-out', str(tls/'ca.crt'), '-days', '2', '-subj', '/CN=Smoke CA')
    run('openssl', 'req', '-newkey', 'rsa:2048', '-nodes', '-keyout', str(tls/'server.key'), '-out', str(tls/'server.csr'), '-subj', '/CN=localhost')
    (tls/'extensions').write_text('subjectAltName=DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\n')
    run('openssl', 'x509', '-req', '-in', str(tls/'server.csr'), '-CA', str(tls/'ca.crt'), '-CAkey', str(tls/'ca.key'), '-CAcreateserial', '-out', str(tls/'server.crt'), '-days', '2', '-extfile', str(tls/'extensions'))
    for name in ['server.key', 'server.crt']:
        run('docker', 'cp', str(tls/name), pg+':/var/lib/postgresql/data/'+name)
    run('docker', 'exec', pg, 'sh', '-c', 'chown postgres:postgres /var/lib/postgresql/data/server.* && chmod 600 /var/lib/postgresql/data/server.key')
    run('docker', 'exec', pg, 'psql', '-U', 'postgres', '-d', 'parseable', '-c', "ALTER SYSTEM SET ssl='on';")
    run('docker', 'exec', pg, 'psql', '-U', 'postgres', '-d', 'parseable', '-c', 'SELECT pg_reload_conf();')
    results['source_commit'] = run('git', 'rev-parse', 'HEAD')
    results['binary_sha256'] = hashlib.sha256((Path(os.environ.get('CARGO_TARGET_DIR', ROOT/'target'))/'debug/parseable').read_bytes()).hexdigest()
    results['source_diff_sha256'] = hashlib.sha256(run('git', 'diff', 'HEAD').encode()).hexdigest()
    results['image_digests'] = {image: json.loads(run('docker', 'image', 'inspect', image))[0]['RepoDigests']
                                for image in ['postgres:17-alpine', 'quay.io/parseablehq/minio:edge']}
    results['measurement'] = 'Node-local storage counter delta during five queries, including background traffic; not isolated requests per query.'
    for mode in modes:
        print('starting '+mode, flush=True)
        bucket = 'smoke-' + mode
        run('docker', 'exec', mini, 'mkdir', '-p', '/data/' + bucket)
        http, grpc, flight = port(), port(), port()
        base = f'http://127.0.0.1:{http}/api/v1'
        env = dict(os.environ, P_ADDR=f'127.0.0.1:{http}', P_GRPC_PORT=str(grpc), P_FLIGHT_PORT=str(flight),
                   P_STAGING_DIR=str(OUT / (mode + '-staging-' + str(os.getpid()))), P_USERNAME='admin', P_PASSWORD='smoke-pass',
                   P_S3_URL=f'http://127.0.0.1:{s3port}', P_S3_BUCKET=bucket, P_S3_REGION='us-east-1',
                   P_S3_ACCESS_KEY='minioadmin', P_S3_SECRET_KEY='minioadmin', P_S3_PATH_STYLE='true', RUST_LOG='warn')
        env.pop('P_METASTORE_POSTGRES_URL', None)
        if mode.startswith('postgres'):
            env['P_METASTORE_POSTGRES_URL'] = f'postgresql://postgres:smoke@127.0.0.1:{pgport}/parseable?sslmode=disable'
        if mode == 'postgres-tls':
            run('docker', 'exec', pg, 'psql', '-U', 'postgres', '-c', 'CREATE DATABASE tls;')
            env['P_METASTORE_POSTGRES_URL'] = f'postgresql://postgres:smoke@localhost:{pgport}/tls?sslmode=require'
            env['P_METASTORE_POSTGRES_CA'] = str(tls/'ca.crt')
        log = open(OUT / (mode + '.log'), 'w')
        def start():
            global server
            server = sp.Popen([str(Path(os.environ.get('CARGO_TARGET_DIR', ROOT / 'target')) / 'debug/parseable'), 's3-store'], env=env, cwd=ROOT, stdout=log, stderr=log)
            processes.append(server)
        def request(path, method='GET', body=None, headers=None, timeout=30):
            data = None if body is None else json.dumps(body).encode()
            req = urllib.request.Request(base + path, data=data, method=method,
                headers={'Authorization': 'Basic ' + base64.b64encode(b'admin:smoke-pass').decode(),
                         'Content-Type': 'application/json', **(headers or {})})
            try:
                with urllib.request.urlopen(req, timeout=timeout) as response:
                    http_requests.append(dict(path=path, method=method, status=response.status))
                    return response.read().decode()
            except urllib.error.HTTPError as error:
                http_requests.append(dict(path=path, method=method, status=error.code))
                error.add_note(error.read().decode())
                raise
        def status(path, method='GET', body=None):
            try:
                request(path, method, body)
                return 200
            except urllib.error.HTTPError as error:
                return error.code
        def ready():
            if server.poll() is not None:
                raise RuntimeError('server exited; inspect ' + str(log.name))
            request('/liveness')
            return True
        results[mode] = {}
        start()
        wait_for(ready)
        if mode == 'postgres-tls':
            stop()
            rejected = env.copy()
            run('openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', str(tls/'wrong.key'), '-out', str(tls/'wrong.crt'), '-days', '2', '-subj', '/CN=Wrong CA')
            rejected['P_METASTORE_POSTGRES_CA'] = str(tls/'wrong.crt')
            prior_logs = postgres_logs(pg)
            attempt = startup_attempt(rejected, 30)
            rejection_logs = postgres_logs(pg)[len(prior_logs):]
            commands.append(dict(argv=attempt.args, exit_code=attempt.returncode))
            assert attempt.returncode != 0
            assert 'error performing tls handshake' in attempt.stdout.lower(), attempt.stdout
            assert 'unknown ca' in rejection_logs.lower(), (attempt.stdout, rejection_logs)
            start()
            wait_for(ready)
            results[mode]['trusted_ca_restart'] = True
            results[mode]['untrusted_ca_rejected'] = True
            results[mode]['untrusted_ca_output'] = attempt.stdout
            results[mode]['untrusted_ca_server_alert'] = rejection_logs
        request('/logstream/smoke', 'PUT')
        request('/ingest', 'POST', [{'message': 'postgres smoke', 'value': 42}], {'X-P-Stream': 'smoke'})
        database = 'tls' if mode == 'postgres-tls' else 'parseable'
        def published(stream):
            if mode.startswith('postgres'):
                raw = run('docker', 'exec', pg, 'psql', '-U', 'postgres', '-d', database, '-Atc',
                          f"SELECT convert_from(body,'UTF8') FROM parseable_documents WHERE tenant='' AND starts_with(key,'{stream}/.stream/') AND right(key,11)='stream.json';")
                documents = [json.loads(line) for line in raw.splitlines()]
            else:
                documents = [json.loads(get_key(env['P_S3_URL'], bucket, key))
                             for key in list_keys(env['P_S3_URL'], bucket)
                             if key.startswith(stream+'/.stream/') and key.endswith('stream.json')]
            return any(document.get('snapshot', {}).get('manifest_list') for document in documents)
        def uploaded():
            return any(key.startswith('smoke/') and key.endswith('.parquet')
                       for key in list_keys(env['P_S3_URL'], bucket)) and published('smoke')
        wait_for(uploaded, 240)
        query = {'query': 'select count(*) as count from smoke',
                 'startTime': (dt.datetime.now(dt.timezone.utc)-dt.timedelta(hours=1)).isoformat(),
                 'endTime': (dt.datetime.now(dt.timezone.utc)+dt.timedelta(minutes=5)).isoformat()}
        first = request('/query', 'POST', query)
        scalar(first, 'count', 1)
        request('/logstream/smoke/retention', 'PUT', [{'description': 'smoke retention', 'action': 'delete', 'duration': '30d'}])
        dashboard = request('/dashboards', 'POST', {'title': 'Postgres smoke', 'tiles': []})
        wait_for_staging_drain(env['P_STAGING_DIR'])
        stop()
        env['P_MODE'] = 'query'
        env['P_QUERIER_ENDPOINT'] = f'127.0.0.1:{http}'
        start()
        wait_for(ready)
        # Publish a stream from another process after this process restarted,
        # so its first query must enter the cold-load path.
        auxiliary_env = env.copy()
        auxiliary_env['P_MODE'] = 'ingest'
        auxiliary_port = port()
        auxiliary_env.update(P_INGESTOR_ENDPOINT=f'127.0.0.1:{auxiliary_port}', P_ADDR=f'127.0.0.1:{auxiliary_port}', P_GRPC_PORT=str(port()), P_FLIGHT_PORT=str(port()),
                             P_STAGING_DIR=str(OUT/(mode+'-aux-'+str(os.getpid()))))
        auxiliary = sp.Popen([str(Path(os.environ.get('CARGO_TARGET_DIR', ROOT/'target'))/'debug/parseable'), 's3-store'], env=auxiliary_env, stdout=log, stderr=log)
        processes.append(auxiliary)
        def aux_request(path, method='GET', body=None, headers=None):
            original_base = base
            # request() closes over base; temporarily use the other node.
            return auxiliary_request(original_base.replace(str(http), str(auxiliary_port)), path, method, body, headers)
        def auxiliary_request(node_base, path, method, body, headers):
            req = urllib.request.Request(node_base+path, method=method,
                data=None if body is None else json.dumps(body).encode(), headers={
                'Authorization': 'Basic '+base64.b64encode(b'admin:smoke-pass').decode(),
                'Content-Type': 'application/json', **(headers or {})})
            with urllib.request.urlopen(req, timeout=30) as response:
                return response.read().decode()
        wait_for(lambda: aux_request('/liveness') == '')
        aux_request('/ingest', 'POST', [{'message':'lazy reload', 'value':9}], {'X-P-Stream':'lazy'})
        wait_for(lambda: published('lazy'), 240)
        # Snapshot publication is polled before the first cold-load request.
        lazy_query = dict(query, query='select count(*) as count from lazy')
        wait_for(lambda: scalar(request('/query', 'POST', lazy_query, timeout=90), 'count', 1), 240)
        print(mode+': cold load passed', flush=True)
        second = request('/query', 'POST', query)
        assert json.loads(first) == json.loads(second), (first, second)
        assert any(item.get('title') == 'Postgres smoke' for item in json.loads(request('/dashboards'))), request('/dashboards')
        def counts():
            raw = request('/metrics')
            return {line.split()[0]:float(line.split()[1]) for line in raw.splitlines()
                    if line.startswith('parseable_storage_request_response_time_count')}
        before = counts()
        for _ in range(5):
            assert json.loads(request('/query', 'POST', query)) == json.loads(second)
        after = counts()
        delta = {key: value-before.get(key,0) for key,value in after.items() if value-before.get(key,0)}
        keys = list_keys(env['P_S3_URL'], bucket)
        results[mode].update(dict(lazy_reload=True, query=second,dashboard=json.loads(dashboard),keys=keys,
                             non_parquet_keys=[k for k in keys if not k.endswith('.parquet')],
                             request_delta=delta, observed_requests_during_window_divided_by_queries=sum(delta.values())/5))
        if mode.startswith('postgres'):
            assert results[mode]['non_parquet_keys'] == ['.parseable/postgres-metastore-id']
            run('docker', 'stop', pg)
            started = time.monotonic()
            assert status('/readiness') == 503
            assert status('/logstream/outage', 'PUT') >= 400
            elapsed = time.monotonic()-started
            assert elapsed < 10, elapsed
            results[mode]['database_outage'] = dict(readiness=503, request_failed=True, seconds=elapsed)
            run('docker', 'start', pg)
            wait_for(lambda: status('/readiness') == 200)
            assert json.loads(request('/query', 'POST', query)) == json.loads(second)
        run('docker', 'stop', mini)
        assert status('/readiness') == 503
        results[mode]['bucket_outage_readiness'] = 503
        run('docker', 'start', mini)
        wait_for(lambda: status('/readiness') == 200)
        request('/logstream/smoke', 'DELETE')
        if mode.startswith('postgres'):
            database = 'tls' if mode == 'postgres-tls' else 'parseable'
            remaining = run('docker', 'exec', pg, 'psql', '-U', 'postgres', '-d', database, '-Atc', "SELECT count(*) FROM parseable_documents WHERE starts_with(key,'smoke/');")
            assert remaining == '0', remaining
            results[mode]['deleted_stream_rows'] = 0
        assert not any(k.startswith('smoke/') for k in list_keys(env['P_S3_URL'], bucket))
        request('/logstream/smoke', 'PUT')
        aux_request('/ingest', 'POST', [{'message': 'recreated', 'value': 7}], {'X-P-Stream': 'smoke'})
        wait_for(uploaded, 240)
        wait_for(lambda: scalar(request('/query', 'POST', query, timeout=90), 'count', 1), 240)
        recreated_query = dict(query, query='select sum(value) as value from smoke')
        wait_for(lambda: scalar(request('/query', 'POST', recreated_query, timeout=90), 'value', 7), 240)
        results[mode]['delete_recreate'] = True
        print(mode+': lifecycle and outages passed', flush=True)
        final_keys = list_keys(env['P_S3_URL'], bucket)
        results[mode]['final_keys'] = final_keys
        if mode.startswith('postgres'):
            assert [k for k in final_keys if not k.endswith('.parquet')] == ['.parseable/postgres-metastore-id']
        if mode.startswith('postgres'):
            restart_faults = []
            for fault in ['before-data', 'after-data']:
                aux_request('/ingest', 'POST', [{'value': 7}], {'X-P-Stream': 'smoke'})
                wait_for(uploaded, 240)
                sql = lambda text: run('docker', 'exec', pg, 'psql', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', database, '-Atc', text)
                if fault == 'before-data':
                    sql("INSERT INTO parseable_documents(tenant,key,kind,body) VALUES('','smoke/.stream/.deleting','document',''::bytea);")
                else:
                    sql("CREATE FUNCTION smoke_delete_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected row deletion failure'; END $$; CREATE TRIGGER smoke_delete_fault BEFORE DELETE ON parseable_documents FOR EACH ROW EXECUTE FUNCTION smoke_delete_fault();")
                    assert status('/logstream/smoke', 'DELETE') >= 400
                    sql('DROP TRIGGER smoke_delete_fault ON parseable_documents; DROP FUNCTION smoke_delete_fault();')
                stop()
                start()
                wait_for(ready)
                listing = json.loads(request('/logstream'))
                assert all(item.get('name') != 'smoke' for item in listing), listing
                assert status('/query', 'POST', query) >= 400, 'cold loader admitted deleting stream'
                request('/logstream/smoke', 'DELETE')
                assert sql("SELECT count(*) FROM parseable_documents WHERE starts_with(key,'smoke/');") == '0'
                assert not any(k.startswith('smoke/') for k in list_keys(env['P_S3_URL'], bucket))
                request('/logstream/smoke', 'PUT')
                request('/logstream/smoke', 'DELETE')
                restart_faults.append(dict(step=fault, hidden=True, cold_load_rejected=True, http_retry=True, recreation=True))
                request('/logstream/smoke', 'PUT')
            results[mode]['interrupted_deletion_restart'] = restart_faults
        stop()
        auxiliary.terminate()
        try:
            auxiliary.wait(timeout=15)
        except sp.TimeoutExpired:
            auxiliary.kill()
            auxiliary.wait()
        auxiliary = None
        log.close()
    failures = {}
    # The final loop environment is PostgreSQL mode. Assert startup rejects a
    # future schema and a pinned UUID mismatch before any HTTP listener starts.
    for case in ['future-schema', 'wrong-id', 'unreachable']:
        rejected_env = env.copy()
        if case == 'future-schema':
            run('docker', 'exec', pg, 'psql', '-U', 'postgres', '-d', database, '-c',
                'UPDATE parseable_backend SET schema_version=3;')
        elif case == 'wrong-id':
            rejected_env['P_METASTORE_POSTGRES_ID'] = 'wrong-backend'
        else:
            rejected_env['P_METASTORE_POSTGRES_URL'] = f'postgresql://postgres:smoke@127.0.0.1:{port()}/parseable?sslmode=disable'
        attempt = startup_attempt(rejected_env, 20)
        commands.append(dict(argv=attempt.args, exit_code=attempt.returncode))
        assert attempt.returncode != 0, (case, attempt.stdout)
        assert 'PostgreSQL' in attempt.stdout, (case, attempt.stdout)
        failures[case] = attempt.stdout
        if case == 'future-schema':
            run('docker', 'exec', pg, 'psql', '-U', 'postgres', '-d', database, '-c',
                'UPDATE parseable_backend SET schema_version=2;')
    results['startup_rejections'] = failures
    results['postgres_rows'] = run('docker','exec',pg,'psql','-U','postgres','-d',database,'-c',
        'SELECT tenant,kind,key,version,octet_length(body) AS bytes FROM parseable_documents ORDER BY tenant,key;')
    (OUT/'results.json').write_text(json.dumps(results,indent=2))
    print(json.dumps(results,indent=2))
finally:
    cleanup()
    atexit.unregister(cleanup)
