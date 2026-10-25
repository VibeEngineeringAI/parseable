#!/usr/bin/env python3
"""Local, isolated Parseable binary A/B. Stdlib only; fails on HTTP/count errors."""
import argparse, base64, concurrent.futures, datetime, hashlib, http.client
import json, os, pathlib, signal, socket, statistics, subprocess, threading, time

AUTH = 'Basic ' + base64.b64encode(b'bench:bench-local-only').decode()

def request(port, method, path, body=None, stream=None, connection=None):
    connection = connection or http.client.HTTPConnection('127.0.0.1', port, timeout=90)
    headers = {'Authorization': AUTH, 'Content-Type': 'application/json'}
    if stream: headers['X-P-Stream'] = stream
    connection.request(method, path, body=body, headers=headers)
    response = connection.getresponse()
    data = response.read()
    if not 200 <= response.status < 300:
        raise RuntimeError((method, path, response.status, data[:1500].decode(errors='replace')))
    return data

def snapshot(pid):
    text = pathlib.Path(f'/proc/{pid}/stat').read_text().split(') ', 1)[1].split()
    status = pathlib.Path(f'/proc/{pid}/status').read_text().splitlines()
    rss = next(int(s.split()[1])*1024 for s in status if s.startswith('VmRSS:'))
    return {'cpu_s': (int(text[11])+int(text[12])) / os.sysconf('SC_CLK_TCK'), 'rss_bytes': rss}

def wait_ready(process, port, runroot):
    for _ in range(180):
        if process.poll() is not None: raise RuntimeError(f'server exited: {runroot}/server.log')
        try: request(port, 'GET', '/api/v1/liveness'); return
        except (OSError, RuntimeError): time.sleep(.5)
    raise RuntimeError('server readiness timeout')

def fixture(rows, width, nested):
    items = []
    for i in range(rows):
        row = {'request_id': '__REQUEST_ID__', 'row_id': i, 'service': 'ingestion-benchmark', 'message': f'event {i}: request handled'}
        for j in range(width-3):
            row[f'field_{j:03}'] = [i+j, i/7, f'value-{i%29}-{j}', bool(i%2)][j%4]
        if nested: row['context'] = {'region': 'west', 'status': 200}
        items.append(row)
    return json.dumps(items, separators=(',', ':'), ensure_ascii=False).encode()

def identified(payload, request_id):
    return payload.replace(b'__REQUEST_ID__', f'{request_id:08d}'.encode())

def verify_requests(port, stream, rows, requests):
    query = {'query': f'SELECT request_id, COUNT(*) AS n, COUNT(DISTINCT row_id) AS unique_rows, MIN(row_id) AS lo, MAX(row_id) AS hi FROM {stream} GROUP BY request_id ORDER BY request_id', 'startTime':'1h', 'endTime':'now'}
    observed = json.loads(request(port, 'POST', '/api/v1/query', json.dumps(query).encode()))
    expected = [{'request_id': f'{i:08d}', 'n': rows, 'unique_rows': rows, 'lo': 0, 'hi': rows-1} for i in range(requests)]
    assert observed == expected, (stream, 'request/row identity mismatch', observed[:5], len(observed), requests)
    return requests * rows

def run_case(port, pid, name, rows, width, nested, concurrency, requests):
    payload = fixture(rows, width, nested)
    stream = 'bench' + name.replace('_', '')
    for i in range(4): request(port, 'POST', '/api/v1/ingest', identified(payload, i), stream)
    # All request payloads are prepared outside timing, including identity assignment.
    assert len(payload)*requests <= 768*2**20, "client payload budget exceeded"
    payloads = [identified(payload, i+4) for i in range(requests)]
    barrier = threading.Barrier(concurrency + 1)
    def worker(index):
        conn = http.client.HTTPConnection('127.0.0.1', port, timeout=90)
        latencies = []
        barrier.wait()
        for i in range(index, requests, concurrency):
            start = time.perf_counter()
            request(port, 'POST', '/api/v1/ingest', payloads[i], stream, conn)
            latencies.append(time.perf_counter()-start)
        conn.close()
        return latencies
    wallclock_start = time.time()
    before = snapshot(pid)
    with concurrent.futures.ThreadPoolExecutor(max_workers=concurrency) as pool:
        futures = [pool.submit(worker, i) for i in range(concurrency)]
        start = time.perf_counter()
        barrier.wait()
        latencies = [v for f in futures for v in f.result()]
        elapsed = time.perf_counter()-start
    after = snapshot(pid)
    expected = verify_requests(port, stream, rows, requests+4)
    ordered = sorted(latencies)
    return dict(case=name, rows_per_request=rows, base_fields=width, fields_after_flatten=width+1+(2 if nested else 0), nested=nested, concurrency=concurrency,
                requests=requests, rows=requests*rows, elapsed_s=elapsed, start_minute_phase_s=wallclock_start%60, rows_per_s=requests*rows/elapsed,
                p50_ms=statistics.median(latencies)*1000, p95_ms=ordered[int(.95*(len(ordered)-1))]*1000,
                cpu_s=after['cpu_s']-before['cpu_s'], rss_start=before['rss_bytes'], rss_end=after['rss_bytes'],
                verified_rows=expected, verified_unique_request_rows=True, payload_bytes=len(payloads[0]),
                payload_sha256=hashlib.sha256(payload).hexdigest())

def run_arm(binary, root, arm, pair, cases, cpus, action=None, persisted_restart_check=None):
    runroot = root / f'pair{pair}-{arm}'
    runroot.mkdir()
    for d in ['data', 'staging']: (runroot/d).mkdir()
    with socket.socket() as sock:
        sock.bind(('127.0.0.1',0)); port = sock.getsockname()[1]
    env = {k:v for k,v in os.environ.items() if not k.startswith('P_')}
    env.update(P_ADDR=f'127.0.0.1:{port}', P_USERNAME='bench', P_PASSWORD='bench-local-only',
               P_FS_DIR=str(runroot/'data'), P_STAGING_DIR=str(runroot/'staging'),
               P_SEND_ANONYMOUS_USAGE_DATA='false', P_CHECK_UPDATE='false',
               P_ACTIX_NUM_WORKERS='4', RAYON_NUM_THREADS='4', RUST_LOG='warn')
    for setting in ['P_GRPC_PORT','P_FLIGHT_PORT','P_QUERY_GRPC_PORT']:
        with socket.socket() as sock:
            sock.bind(('127.0.0.1',0)); env[setting] = str(sock.getsockname()[1])
    command = (['taskset', '-c', cpus] if cpus else []) + [str(binary), 'local-store']
    (runroot/'run-metadata.json').write_text(json.dumps({'binary_sha256':hashlib.sha256(binary.read_bytes()).hexdigest(),'cpus':cpus,'env_overrides':{k:v for k,v in env.items() if (k.startswith('P_') and k!='P_PASSWORD') or k in ['RAYON_NUM_THREADS','RUST_LOG']},'loadavg':os.getloadavg(),'utc':datetime.datetime.now(datetime.timezone.utc).isoformat()},indent=2))
    with (runroot/'server.log').open('w') as log:
        process = subprocess.Popen(command, env=env, cwd=runroot, stdout=log, stderr=subprocess.STDOUT)
        try:
            wait_ready(process, port, runroot)
            if action is not None:
                result = action(port, process.pid)
                (runroot/'result.json').write_text(json.dumps(result, indent=2))
                if persisted_restart_check is not None:
                    process.kill(); process.wait()
                    # Own disposable staging only: preserve it, then restart with an empty directory.
                    (runroot/'staging').rename(runroot/'staging-drained')
                    (runroot/'staging').mkdir()
                    process = subprocess.Popen(command, env=env, cwd=runroot, stdout=log, stderr=subprocess.STDOUT)
                    wait_ready(process, port, runroot)
                    persisted_restart_check(port)
                    result['persisted_only_restart_verified'] = True
                    (runroot/'result.json').write_text(json.dumps(result, indent=2))
                return result
            for case in cases:
                result = run_case(port, process.pid, *case)
                result.update(arm=arm, pair=pair, binary_sha256=hashlib.sha256(binary.read_bytes()).hexdigest(),
                              loadavg=os.getloadavg(), utc=datetime.datetime.now(datetime.timezone.utc).isoformat())
                with (root/'measurements.jsonl').open('a') as out: out.write(json.dumps(result)+'\n')
                print(json.dumps(result), flush=True)
            # Recovery is outside all timing windows. Kill only this disposable process.
            process.kill(); process.wait()
            process = subprocess.Popen(command, env=env, cwd=runroot, stdout=log, stderr=subprocess.STDOUT)
            wait_ready(process, port, runroot)
            recovery = []
            for name, rows, width, nested, concurrency, requests in cases:
                stream = 'bench' + name.replace('_','')
                restart_start = time.monotonic()
                for attempt in range(120):
                    try:
                        verify_requests(port, stream, rows, requests+4)
                        break
                    except AssertionError:
                        time.sleep(1)
                else: raise AssertionError((name,'recovery timeout'))
                recovery.append({'case':name,'verified_after_sigkill':(requests+4)*rows,'recovery_wait_s':time.monotonic()-restart_start})
            (runroot/'recovery.json').write_text(json.dumps(recovery,indent=2))
        finally:
            process.send_signal(signal.SIGINT)
            try: process.wait(timeout=45)
            except subprocess.TimeoutExpired: process.kill(); process.wait()

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--baseline', type=pathlib.Path, required=True)
    parser.add_argument('--candidate', type=pathlib.Path, required=True)
    parser.add_argument('--output', type=pathlib.Path, required=True)
    parser.add_argument('--pairs', type=int, default=4)
    parser.add_argument('--cpus', default='2,4,6,8')
    parser.add_argument('--smoke', action='store_true')
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=False)
    cases = [('app10_c1',10,20,True,1,10000), ('app1000_c1',1000,20,True,1,800),
             ('app1000_c4',1000,20,True,4,800), ('wide1000_c1',1000,58,False,1,400),
             ('wide1000_c4',1000,58,False,4,400)]
    if args.smoke: cases = [('smoke',10,20,True,1,8)]
    for pair in range(args.pairs):
        order = ['baseline','candidate'] if pair%2 == 0 else ['candidate','baseline']
        for arm in order: run_arm(getattr(args,arm).resolve(),args.output.resolve(),arm,pair,cases,args.cpus)

if __name__ == '__main__': main()
