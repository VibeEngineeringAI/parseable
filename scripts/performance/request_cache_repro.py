#!/usr/bin/env python3
"""Run against the isolated fixture/server described in validated-small-file-cache.md.
Set CACHE_REPRO_ASSERT_ONCE=1 after the fix. Every shape runs twice, with a fresh
HTTP request, and measures the second request. No third-party Python packages.
"""
import base64, collections, datetime, json, os, re, time, urllib.request, urllib.parse
BASE = os.environ.get('CACHE_REPRO_URL', 'http://127.0.0.1:18398')
LOG = os.environ.get('CACHE_REPRO_LOG', 'target/cache-repro/server.log')
HEADERS = {'Authorization': 'Basic ' + base64.b64encode(b'admin:admin').decode(), 'X-P-Stream': 'repro'}
def call(path, body=None):
    headers = dict(HEADERS)
    if body is not None:
        headers['Content-Type'] = 'application/json'
        body = json.dumps(body).encode()
    try:
        with urllib.request.urlopen(urllib.request.Request(BASE + path, data=body, headers=headers), timeout=180) as response:
            return response.read().decode()
    except urllib.error.HTTPError as error:
        raise RuntimeError(error.read().decode()) from error
def metrics():
    return sum(float(line.rsplit(' ', 1)[1]) for line in call('/api/v1/metrics').splitlines() if line.startswith('parseable_storage_request_response_time_count{') and '"GET"' in line)
def stamp(t):
    return datetime.datetime.fromtimestamp(t, datetime.timezone.utc).isoformat()
def query(sql, minutes):
    now = time.time()
    return '/api/v1/query', {'query': sql, 'startTime': stamp(now - minutes*60), 'endTime': stamp(now)}
# Keep the recent staging/remote union in every reproduction.
call('/v1/metrics', {'resourceMetrics': [{'resource': {'attributes': [{'key':'host','value':{'stringValue':'host-0'}}]}, 'scopeMetrics': [{'metrics': [{'name':'cpu','gauge':{'dataPoints':[{'timeUnixNano':str(time.time_ns()),'asDouble':0.5}]}}]}]}]})
now = time.time()
shapes = [
    ('count_10m', *query('SELECT COUNT(*) FROM repro', 10)),
    ('count_1h', *query('SELECT COUNT(*) FROM repro', 60)),
    ('group_1h', *query("SELECT host, SUM(data_point_value) FROM repro WHERE metric_name = 'cpu' GROUP BY host", 60)),
    ('promql_range_1h', '/prometheus/api/v1/query_range?' + urllib.parse.urlencode({'query':'cpu','start':now-3600,'end':now,'step':60}), None),
    ('label_values_1h', '/prometheus/api/v1/label/host/values?' + urllib.parse.urlencode({'match[]':'cpu','start':now-3600,'end':now}), None),
    ('count_24h', *query('SELECT COUNT(*) FROM repro',1440)),
    ('promql_instant','/prometheus/api/v1/query?' + urllib.parse.urlencode({'query':'cpu','time':now}),None),
]
request_file = os.environ.get('CACHE_REPRO_REQUESTS')
if request_file:
    if os.path.exists(request_file):
        with open(request_file) as saved:
            shapes = json.load(saved)
    else:
        with open(request_file, 'w') as saved:
            json.dump(shapes, saved)
for name, path, body in shapes:
    for run in range(2):
        before = metrics()
        offset = os.path.getsize(LOG)
        result = call(path, body)
        after = metrics()
        with open(LOG) as trace:
            trace.seek(offset)
            loads = collections.Counter(re.findall(r'CACHE_LOAD .*path=(\S+)',trace.read()))
        if run:
            print(json.dumps({'shape':name,'calls':int(after-before),'selected_files':len(loads),'validations':sum(loads.values()),'multiplicity':dict(collections.Counter(loads.values()))}), flush=True)
        if os.environ.get('CACHE_REPRO_ASSERT_ONCE'):
            if name in ('count_1h', 'group_1h', 'promql_range_1h', 'label_values_1h'):
                assert len(loads) > 1, (name, 'fixture must select multiple remote files')
            assert all(n == 1 for n in loads.values()), (name, loads)
