#!/usr/bin/env python3
"""Isolated MinIO/PostgreSQL offline migration smoke. No live deployment access.
Uses the existing smoke fixture's helpers; every created container is removed.
"""
from pathlib import Path
import os
import subprocess as sp
import time
import json
import base64
import datetime as dt
import urllib.request

# Load only reusable definitions, never the existing smoke's executable driver.
namespace = {'__file__': str(Path(__file__).with_name('postgres-metastore-smoke.py'))}
source = Path(namespace['__file__']).read_text().split('\ntry:\n    pgport, s3port')[0]
exec(compile(source, namespace['__file__'], 'exec'), namespace)
run, port, container, wait_for, list_keys = [namespace[k] for k in ('run','port','container','wait_for','list_keys')]
root, out = namespace['ROOT'], namespace['OUT']
binary = str(Path(os.environ.get('CARGO_TARGET_DIR', root/'target'))/'debug/parseable')
server = None
log = open(out/'migration.log','w')
def stop():
    global server
    if server:
        server.terminate()
        try: server.wait(timeout=30)
        except sp.TimeoutExpired: server.kill(); server.wait()
        server = None
try:
    pgport, s3port, http = port(), port(), port()
    pg, cmd = container('postgres:17-alpine',POSTGRES_PASSWORD='smoke',POSTGRES_DB='migration')
    run(*cmd,'-p',f'127.0.0.1:{pgport}:5432','postgres:17-alpine')
    mini, cmd = container('quay.io/parseablehq/minio:edge',MINIO_ROOT_USER='minioadmin',MINIO_ROOT_PASSWORD='minioadmin')
    run(*cmd,'-p',f'127.0.0.1:{s3port}:9000','quay.io/parseablehq/minio:edge','server','/data')
    run('docker','exec',mini,'mkdir','-p','/data/migration')
    wait_for(lambda:'accepting connections' in run('docker','exec',pg,'pg_isready','-U','postgres'))
    env = dict(os.environ,P_ADDR=f'127.0.0.1:{http}',P_GRPC_PORT=str(port()),P_FLIGHT_PORT=str(port()),
        P_STAGING_DIR=str(out/f'migration-staging-{os.getpid()}'),P_USERNAME='admin',P_PASSWORD='smoke-pass',
        P_S3_URL=f'http://127.0.0.1:{s3port}',P_S3_BUCKET='migration',P_S3_REGION='us-east-1',
        P_S3_ACCESS_KEY='minioadmin',P_S3_SECRET_KEY='minioadmin',P_S3_PATH_STYLE='true',RUST_LOG='warn')
    env.pop('P_METASTORE_POSTGRES_URL',None)
    pgurl = f'postgresql://postgres:smoke@127.0.0.1:{pgport}/migration?sslmode=disable'
    if os.environ.get('P_MIGRATION_TLS') == '1':
        tls = out / 'migration-tls'
        tls.mkdir(exist_ok=True)
        run('openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', str(tls/'ca.key'), '-out', str(tls/'ca.crt'), '-days', '2', '-subj', '/CN=Smoke CA')
        run('openssl', 'req', '-newkey', 'rsa:2048', '-nodes', '-keyout', str(tls/'server.key'), '-out', str(tls/'server.csr'), '-subj', '/CN=localhost')
        (tls/'extensions').write_text('subjectAltName=DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\n')
        run('openssl', 'x509', '-req', '-in', str(tls/'server.csr'), '-CA', str(tls/'ca.crt'), '-CAkey', str(tls/'ca.key'), '-CAcreateserial', '-out', str(tls/'server.crt'), '-days', '2', '-extfile', str(tls/'extensions'))
        for name in ['server.key', 'server.crt']:
            run('docker', 'cp', str(tls/name), pg+':/var/lib/postgresql/data/'+name)
        run('docker', 'exec', pg, 'sh', '-c', 'chown postgres:postgres /var/lib/postgresql/data/server.* && chmod 600 /var/lib/postgresql/data/server.key')
        run('docker', 'exec', pg, 'psql', '-U', 'postgres', '-d', 'migration', '-c', "ALTER SYSTEM SET ssl='on';")
        run('docker', 'exec', pg, 'psql', '-U', 'postgres', '-d', 'migration', '-c', 'SELECT pg_reload_conf();')

        env['P_METASTORE_POSTGRES_CA'] = str(tls/'ca.crt')
        pgurl = pgurl.replace('sslmode=disable', 'sslmode=require')

    def request(path,method='GET',body=None,headers=None):
        req = urllib.request.Request(f'http://127.0.0.1:{http}/api/v1'+path,method=method,
            data=None if body is None else json.dumps(body).encode(),headers={
            'Authorization':'Basic '+base64.b64encode(b'admin:smoke-pass').decode(),
            'Content-Type':'application/json',**(headers or {})})
        with urllib.request.urlopen(req,timeout=90) as response: return response.read().decode()
    def start():
        global server
        server = sp.Popen([binary,'s3-store'],env=env,stdout=log,stderr=log)
        def ready():
            if server.poll() is not None: raise RuntimeError('server exited: '+str(log.name))
            request('/liveness'); return True
        wait_for(ready)
    def wait_for_staging_drain():
        quiet_since = None
        def drained():
            nonlocal quiet_since
            pending = any(p.is_file() and p.suffix in {'.arrow', '.arrows', '.part', '.parquet'}
                          for p in Path(env['P_STAGING_DIR']).rglob('*'))
            if pending:
                quiet_since = None
                return False
            if quiet_since is None:
                quiet_since = time.monotonic()
            return time.monotonic() - quiet_since >= 2
        wait_for(drained, 300)
    def migrate(action,*flags,expected=0):
        result = sp.run([binary,'s3-store','--metadata-migration',action,'--acknowledge-server-stopped',*flags],
            env=dict(env,P_METASTORE_POSTGRES_URL=pgurl),stdout=log,stderr=log,timeout=180)
        assert (result.returncode == 0) == (expected == 0), (action,result.returncode)
    start()
    for stream in ['first','second','partitioned']:
        request('/logstream/'+stream,'PUT',headers={'X-P-Custom-Partition':'region'} if stream=='partitioned' else None)
        request('/ingest','POST',[{'message':'migration','value':42,'region':'west'}],{'X-P-Stream':stream})
    request('/role/migration-reader','PUT',{'roleType':'user','actions':[{'privilege':'reader','resource':{'stream':'first'}}]})
    request('/user/migration-user','POST',['migration-reader'])
    request('/dashboards','POST',{'title':'Migration dashboard','tiles':[]})
    request('/filters','POST',{'stream_name':'first','filter_name':'Migration filter','query':{'filter_type':'sql','filter_query':'SELECT * FROM first','filter_builder':None},'time_filter':None})
    request('/alerts','POST',{'severity':'high','title':'Migration alert','alertType':'threshold',
        'queryType':'code','query':'select count(*) as count from first','thresholdConfig':{'operator':'>','value':1000},
        'evalConfig':{'rollingWindow':{'evalStart':'10 minutes','evalEnd':'now','evalFrequency':10}},
        'targets':[],'notificationConfig':{'interval':1}})
    wait_for(lambda:sum(k.endswith('manifest.json') for k in list_keys(env['P_S3_URL'],'migration'))>=3,240)
    query={'query':'select sum(value) as value from first',
        'startTime':(dt.datetime.now(dt.timezone.utc)-dt.timedelta(hours=1)).isoformat(),
        'endTime':(dt.datetime.now(dt.timezone.utc)+dt.timedelta(hours=1)).isoformat()}
    before=request('/query','POST',query)
    def normalized(raw):
        def ordered(value):
            if isinstance(value,dict): return {k:ordered(v) for k,v in sorted(value.items())}
            if isinstance(value,list): return sorted([ordered(v) for v in value],key=lambda v:json.dumps(v,sort_keys=True))
            return value
        return ordered(json.loads(raw))
    def snapshot(path):
        value=normalized(request(path))
        if path.endswith('/stats'): value.pop('time',None)  # response generation time
        return value
    # Query statistics are created asynchronously; include the internal stream in both snapshots.
    wait_for(lambda: any(item['name']=='pstats' for item in json.loads(request('/logstream'))),120)
    wait_for_staging_drain()
    saved={p:snapshot(p) for p in ['/logstream','/logstream/first/schema','/logstream/first/info','/logstream/first/stats','/dashboards','/filters','/user','/alerts']}
    wait_for_staging_drain()
    stop()
    stuck = Path(env['P_STAGING_DIR'])/'stranded.part'
    stuck.write_bytes(b'unsynced')
    migrate('import','--dry-run',expected=1)
    stuck.unlink()

    print('object-store fixture uploaded; starting offline import',flush=True)
    migrate('verify',expected=1)
    migrate('import','--dry-run')
    # Upload actual S3 metadata objects so interruption is observable on MinIO's XL layout.
    for i in range(500):
        namespace['get_key'](env['P_S3_URL'], 'migration', f'.settings/migration-fixtures/{i}.json', body=b'{}')
    interrupted=sp.Popen([binary,'s3-store','--metadata-migration','import','--acknowledge-server-stopped'],
        env=dict(env,P_METASTORE_POSTGRES_URL=pgurl),stdout=log,stderr=log)
    deadline=time.monotonic()+120
    while '.parseable/metastore-migration' not in list_keys(env['P_S3_URL'],'migration'):
        assert interrupted.poll() is None, 'import completed before interruption'
        assert time.monotonic()<deadline
        time.sleep(0.01)
    interrupted.kill(); interrupted.wait(timeout=30)
    for attempt_env in [env, dict(env,P_METASTORE_POSTGRES_URL=pgurl)]:
        rejected=sp.run([binary,'s3-store'],env=attempt_env,stdout=log,stderr=log,timeout=30)
        assert rejected.returncode != 0, 'incomplete import admitted a server'
    migrate('import')
    migrate('verify')
    migrate('import',expected=1)
    rejected=sp.run([binary,'s3-store'],env=env,stdout=log,stderr=log,timeout=30)
    assert rejected.returncode != 0
    env['P_METASTORE_POSTGRES_URL']=pgurl
    start()
    assert request('/query','POST',query)==before
    for p in saved:
        if p == '/alerts': assert 'Migration alert' in request(p)
        else: assert snapshot(p)==saved[p],(p, snapshot(p), saved[p])
    print('PostgreSQL queries and metadata match',flush=True)
    request('/ingest','POST',[{'value':7,'message':'after import'}],{'X-P-Stream':'first'})
    wait_for(lambda:'49' in request('/query','POST',query))
    # Quiesce actual event buffers before exercising offline export.
    wait_for_staging_drain()
    # /info caches event bounds; wait for the new published minute instead of
    # capturing a stale cache entry and comparing it to a cold rollback server.
    latest_query = dict(query, query="select date_trunc('minute', max(p_timestamp)) as latest from first")
    latest_minute = json.loads(request('/query','POST',latest_query))[0]['latest']
    expected_latest = dt.datetime.fromisoformat(latest_minute.replace('Z','+00:00')).replace(tzinfo=dt.timezone.utc)
    def bounds_published():
        value = json.loads(request('/logstream/first/info'))['latestEventAt']
        return dt.datetime.fromisoformat(value.replace('Z','+00:00')) >= expected_latest
    wait_for(bounds_published)
    latest={p:snapshot(p) for p in saved if p != '/alerts'}
    stop()
    print('new PostgreSQL rows ingested; starting offline export',flush=True)
    export=sp.Popen([binary,'s3-store','--metadata-migration','export','--acknowledge-server-stopped'],env=env,stdout=log,stderr=log)
    deadline=time.monotonic()+120
    while '.parseable/metastore-migration' not in list_keys(env['P_S3_URL'],'migration'):
        assert export.poll() is None, 'export completed before interruption'
        assert time.monotonic()<deadline
        time.sleep(0.01)
    export.kill(); export.wait(timeout=30)
    migrate('export')
    migrate('verify')
    del env['P_METASTORE_POSTGRES_URL']
    start()
    assert '49' in request('/query','POST',query)
    for p in latest: assert snapshot(p)==latest[p],(p,snapshot(p),latest[p])
    assert 'Migration alert' in request('/alerts')
    print('migration MinIO round trip passed',flush=True)
finally:
    stop()
    log.close()
    for name in reversed(namespace['containers']): sp.run(['docker','rm','-f',name],stdout=sp.DEVNULL)
