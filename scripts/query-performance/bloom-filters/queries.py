"""HTTP evidence with per-query CPU, metrics and EXPLAIN ANALYZE. Server must be idle.
usage: queries.py PORT PID PRESENT_ID OUTPUT START END
Set PRESENT_TIME to the matching record timestamp; local credentials default to admin:admin.
"""
import base64, http.client, json, os, re, statistics, sys, time
port, pid, present, output = int(sys.argv[1]), int(sys.argv[2]), sys.argv[3], sys.argv[4]
reps = int(os.environ.get('BLOOM_QUERY_REPS','7'))
start, end = sys.argv[5:7]
present_time = os.environ['PRESENT_TIME']
auth = 'Basic ' + base64.b64encode((os.environ.get('P_USERNAME', 'admin') + ':' + os.environ.get('P_PASSWORD', 'admin')).encode()).decode()
absent = '8000000000000000000000000000abcd'
queries = {
    'absent': f"SELECT * FROM applogs WHERE trace_id = '{absent}' LIMIT 10",
    'present': f"SELECT * FROM applogs WHERE trace_id = '{present}' LIMIT 10",
    'in10': "SELECT * FROM applogs WHERE trace_id IN (" + ','.join("'%032x'" % (2**127+i*991) for i in range(10)) + ') LIMIT 10',
    'id_order': f"SELECT * FROM applogs WHERE trace_id = '{absent}' ORDER BY p_timestamp DESC LIMIT 100",
    'short_present': f"SELECT * FROM applogs WHERE trace_id = '{present}' AND p_timestamp >= TIMESTAMP '{present_time}' - INTERVAL '5 seconds' AND p_timestamp <= TIMESTAMP '{present_time}' + INTERVAL '5 seconds' LIMIT 10",
    'count': 'SELECT COUNT(*) FROM applogs',
    'latest': 'SELECT * FROM applogs ORDER BY p_timestamp DESC LIMIT 100',
    'group': 'SELECT service, level, COUNT(*) c FROM applogs GROUP BY service, level ORDER BY c DESC',
    'not_equal': f"SELECT COUNT(*) FROM applogs WHERE trace_id != '{absent}'",
    'like': "SELECT COUNT(*) FROM applogs WHERE trace_id LIKE '8000%'",
    'cast': f"SELECT * FROM applogs WHERE CAST(trace_id AS VARCHAR) = '{absent}' LIMIT 10",
    'utf8': f"SELECT * FROM applogs WHERE arrow_cast(trace_id, 'Utf8') = '{absent}' LIMIT 10",
    'utf8view': f"SELECT * FROM applogs WHERE arrow_cast(trace_id, 'Utf8View') = '{absent}' LIMIT 10",
    'cast_numeric': "SELECT COUNT(*) FROM applogs WHERE TRY_CAST(trace_id AS BIGINT) = 42",

}
def req(path, body=None):
    c = http.client.HTTPConnection('127.0.0.1', port, timeout=300)
    c.request('POST' if body else 'GET', '/api/v1/' + path, body=json.dumps(body) if body else None, headers={'Authorization': auth, 'Content-Type': 'application/json', 'Accept': 'text/plain' if path == 'metrics' else 'application/json'})
    r = c.getresponse(); data = r.read(); c.close()
    if r.status != 200: raise RuntimeError((r.status, data[:1000]))
    return data.decode()
def cpu():
    f = open(f'/proc/{pid}/stat').read().rsplit(') ',1)[1].split()
    return (int(f[11])+int(f[12])) / os.sysconf('SC_CLK_TCK')
def gets():
    text = req('metrics')
    counts = {'GET': 0, 'GET_RANGES': 0}
    for line in text.splitlines():
        if line.startswith('parseable_storage_request_response_time_count{'):
            m=re.search(r'method="(GET|GET_RANGES)"',line)
            if m: counts[m[1]]+=float(line.rsplit(' ',1)[1])
    return counts

results = {}
for name, sql in queries.items():
    body = {'query': sql, 'startTime': start, 'endTime': end}
    req('query', body) # warmup
    times, cpus, counts = [], [], []
    for _ in range(reps):
        g, c, t = gets(), cpu(), time.perf_counter()
        data = req('query', body)
        times.append((time.perf_counter()-t)*1000); cpus.append((cpu()-c)*1000); after=gets(); counts.append({m:after[m]-g[m] for m in g})
    explain = req('query', dict(body, query='EXPLAIN ANALYZE ' + sql))
    results[name] = {'p50_ms': statistics.median(times), 'min_ms': min(times), 'max_ms': max(times), 'cpu_ms': statistics.mean(cpus), 'GETs': statistics.mean(c['GET'] for c in counts), 'GET_RANGES': statistics.mean(c['GET_RANGES'] for c in counts), 'response': data if len(data)<1000 else data[:1000], 'explain': explain}
    print(name, {k:v for k,v in results[name].items() if k not in ('response','explain')}, flush=True)
    open(output,'w').write(json.dumps(results,indent=2))
