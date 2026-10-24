#!/usr/bin/env python3
"""Byte-exact request corpus; compare status/errors, logical rows, schemas and accounting."""
import argparse, http.client, json, pathlib
from run import AUTH, run_arm

# Independent expectations: equal failures in the two binaries are not success.
EXPECTED_STATUSES = {
    'flat': [200, 200], 'nested': [200, 200], 'collision': [200],
    'arrays': [200], 'nestedarrays': [200], 'evolution': [200, 200, 200],
    'renames': [200, 400], 'duplicates': [400, 400, 400, 400],
    'numbers': [200, 200, 400], 'timestamps': [200, 200],
    'partitioned': [200, 400, 400],
    # Inherited partial-ingest failure, deliberately pinned rather than allowing 5xx.
    'partitiontypes': [500], 'invalidinferheader': [],
    'static': [200, 200, 400, 400, 400],
    'otlpempty': [200], 'otlpoverflow': [400],
    'otlpduplicates': [200], 'otlpsnake': [400],
    'otlpvalidlogs': [200], 'otlpvalidmetrics': [200], 'otlpvalidtraces': [200],
}
EXPECTED_COUNTS = {
    'flat': 2, 'nested': 2, 'collision': 2, 'arrays': 5, 'nestedarrays': 4,
    'evolution': 4, 'renames': 1, 'duplicates': 0, 'numbers': 2,
    'timestamps': 3, 'partitioned': 3, 'partitiontypes': 1, 'static': 2,
    'otlpvalidlogs': 1, 'otlpvalidmetrics': 2, 'otlpvalidtraces': 1,
}

def validate_result(item):
    name = item['name']
    responses = [item['response']] if 'response' in item else item['responses']
    assert [r[0] for r in responses] == EXPECTED_STATUSES[name], item
    if 'creation' in item:
        assert item['creation'][0] == (400 if name == 'invalidinferheader' else 200), item
    if name == 'invalidinferheader':
        assert [item[k][0] for k in ('schema', 'ingestion', 'rows')] == [404, 404, 400], item
    if name in EXPECTED_COUNTS:
        count = EXPECTED_COUNTS[name]
        assert all(item[k][0] == 200 for k in ('schema', 'ingestion', 'rows')), item
        assert isinstance(item['rows'][1], list) and len(item['rows'][1]) == count, item
        assert isinstance(item['schema'][1], dict) and isinstance(item['schema'][1].get('fields'), list), item
        stats = item['ingestion'][1]
        assert isinstance(stats, dict) and stats.get('count') == stats.get('lifetime_count') == count, item
    if name == 'static':
        fields = item['schema'][1]['fields']
        types = {
            'id': 'Int64', 'v': 'Float64', 'when': {'Timestamp': ['Millisecond', None]},
            'day': 'Date32', 'ok': 'Boolean', 'text': 'Utf8',
            'p_timestamp': {'Timestamp': ['Millisecond', None]},
        }
        assert len(fields) == len(types) and {f['name']: f['data_type'] for f in fields} == types, item
        assert all(f['nullable'] for f in fields), item
        expected = [
            {'id': 1, 'v': 1.5, 'when': '2026-10-23T18:30:00', 'day': '2026-10-23', 'ok': True, 'text': 'hello'},
            {'id': 2, 'v': 3.5, 'when': None, 'day': None, 'ok': None, 'text': 'numeric strings'},
        ]
        # Match types too: Python otherwise considers True == 1 and 2.0 == 2.
        canonical = lambda rows: sorted(json.dumps(row, sort_keys=True) for row in rows)
        assert canonical(item['rows'][1]) == canonical(expected), item

def raw(port, method, path, body=b'', headers=None):
    conn = http.client.HTTPConnection('127.0.0.1', port, timeout=60)
    conn.request(method,path,body,{'Authorization':AUTH,'Content-Type':'application/json', **(headers or {})})
    response = conn.getresponse(); body = response.read(); conn.close()
    try: value = json.loads(body)
    except ValueError: value = body.decode(errors='replace')
    return response.status, value

def corpus():
    cases = [
        ('flat', [b'{"id":1,"value":3,"name":"alpha","ok":true}', b'{"id":2,"value":4,"name":"beta","ok":false}'], {}),
        ('nested', [b'{"id":1,"a":{"b":2},"empty":{}}', b'{"id":2,"a":{"b":3},"empty":{}}'], {}),
        ('collision', [b'[{"id":1,"a":{"b":1},"a_b":2},{"id":2,"a_b":2,"a":{"b":1}}]'], {}),
        ('arrays', [b'[{"id":1,"a":[1,2],"b":["x","y"]},{"id":2,"a":[],"b":["z"]}]'], {}),
        ('nestedarrays', [b'{"id":1,"a":{"b":[[1,2],[],[3]]}}'], {}),
        ('evolution', [b'{"id":1,"v":3}',b'{"id":2,"new":null,"v":"text"}',b'[{"id":3,"v":true},{"id":4,"v":1.5}]'], {}),
        ('renames', [b'{"id":1,"@level":"info"}',b'{"id":2,"@level":"info","_level":"error"}'], {}),
        ('duplicates', [b'{"id":1,"id":2}',b'{"a":{"x":1,"x":2}}',b'{"x":1,"x":2,"broken":}',b'{"x":1,"\\u0078":2}'], {}),
        ('numbers', [b'{"id":1,"v":18446744073709551615}',b'{"id":2,"v":-9223372036854775808}',b'{"id":3,"v":1e400}'], {}),
        ('timestamps', [b'{"id":1,"time":"2026-10-23T10:00:00Z"}',b'[{"id":2,"time":"not a date"},{"id":3,"time":"2026-10-23T10:01:00Z"}]'], {}),
        ('partitioned', [b'[{"id":1,"tenant":"a","v":3},{"id":2,"tenant":"b","v":4},{"id":3,"tenant":"a","v":5}]',b'{"id":4,"tenant":null}',b'{"id":5,"tenant":"a.b"}'], {'x-p-custom-partition':'tenant'}),
        ('partitiontypes', [b'[{"tenant":"a","v":true},{"tenant":"a","v":"x"}]'], {'x-p-custom-partition':'tenant'}),
        ('invalidinferheader', [], {'x-p-infer-timestamp':'false'}),
    ]
    return cases

def inspect(port,stream):
    schema = raw(port,'GET',f'/api/v1/logstream/{stream}/schema')
    status, stats = raw(port,'GET',f'/api/v1/logstream/{stream}/stats')
    ingestion = [status, stats.get('ingestion') if isinstance(stats,dict) else stats]
    query = {'query':f'SELECT * FROM {stream} LIMIT 10000','startTime':'1h','endTime':'now','sendNull':True}
    status, rows = raw(port,'POST','/api/v1/query',json.dumps(query).encode())
    if status == 200 and isinstance(rows,list):
        for row in rows: row.pop('p_timestamp',None)
        rows.sort(key=lambda row:json.dumps(row,sort_keys=True))
    return {'schema':schema,'ingestion':ingestion,'rows':[status,rows]}

def run(port, pid):
    results = []
    for name, bodies, createheaders in corpus():
        stream = 'compat' + name
        item = {'name':name, 'creation':raw(port,'PUT',f'/api/v1/logstream/{stream}',headers=createheaders), 'responses':[]}
        assert item['creation'][0] == (400 if name=='invalidinferheader' else 200), item
        for body in bodies: item['responses'].append(raw(port,'POST','/api/v1/ingest',body,{'x-p-stream':stream}))
        item.update(inspect(port,stream))
        results.append(item)
    stream='compatstatic'
    static={'fields':[{'name':name,'data_type':kind} for name,kind in [('id','int'),('v','double'),('when','datetime'),('day','date'),('ok','boolean'),('text','string')]]}
    creation=raw(port,'PUT',f'/api/v1/logstream/{stream}',json.dumps(static).encode(),{'x-p-static-schema-flag':'true'})
    assert creation[0]==200,creation
    responses=[]
    for body in [
        b'{"id":1,"v":1.5,"when":"2026-10-23T18:30:00Z","day":"2026-10-23","ok":true,"text":"hello"}',
        b'{"id":" 2 ","v":"3.5","text":"numeric strings"}',
        b'{"id":3,"new":null}',
        b'{"id":4,"when":"Fri, 23 Oct 2026 18:30:00 +0000"}',
        b'{"id":5,"ok":"true"}',
    ]: responses.append(raw(port,'POST','/api/v1/ingest',body,{'x-p-stream':stream}))
    results.append({'name':'static','creation':creation,'responses':responses,**inspect(port,stream)})
    # Raw OTLP counterexamples must preserve the existing JSON->Value behavior.
    for name, body in [
        ('empty',b'{"resourceLogs":[]}'),
        ('overflow',b'{"resourceLogs":[],"unknown":1e400}'),
        ('duplicates',b'{"resourceLogs":[{}],"resourceLogs":[]}'),
        ('snake',b'{"resource_logs":[]}'),
    ]:
        results.append({'name':'otlp'+name, 'response':raw(port,'POST','/v1/logs',body,{'x-p-stream':'compatotel'+name})})
    timestamp='1792780200000000000'
    resource={'attributes':[{'key':'service.name','value':{'stringValue':'compatibility'}}]}
    scope={'name':'compatibility'}
    otlp={
        'logs':{'resourceLogs':[{'resource':resource,'scopeLogs':[{'scope':scope,'logRecords':[{'timeUnixNano':timestamp,'observedTimeUnixNano':timestamp,'severityNumber':9,'severityText':'INFO','body':{'stringValue':'hello'},'attributes':[{'key':'id','value':{'intValue':'7'}}]}]}]}]},
        'metrics':{'resourceMetrics':[{'resource':resource,'scopeMetrics':[{'scope':scope,'metrics':[{'name':'compat.gauge','description':'sample','unit':'1','gauge':{'dataPoints':[{'timeUnixNano':timestamp,'startTimeUnixNano':timestamp,'asDouble':1.5,'attributes':[]}]}}]}]}]},
        'traces':{'resourceSpans':[{'resource':resource,'scopeSpans':[{'scope':scope,'spans':[{'traceId':'0123456789abcdef0123456789abcdef','spanId':'0123456789abcdef','name':'compat.span','kind':2,'startTimeUnixNano':timestamp,'endTimeUnixNano':str(int(timestamp)+1000000),'attributes':[],'status':{'code':1}}]}]}]},
    }
    for signal,payload in otlp.items():
        stream='compatotel'+signal
        creation=raw(port,'PUT',f'/api/v1/logstream/{stream}',headers={'x-p-log-source':'otel-'+signal})
        response=raw(port,'POST','/v1/'+signal,json.dumps(payload).encode(),{'x-p-stream':stream})
        assert 200 <= response[0] < 300,(signal,response)
        item={'name':'otlpvalid'+signal,'creation':creation,'response':response}
        item.update(inspect(port,stream))
        assert creation[0]==200 and item['schema'][0]==200 and item['rows'][0]==200,item
        assert len(item['rows'][1])=={'logs':1,'metrics':2,'traces':1}[signal],item
        results.append(item)
    assert {item['name'] for item in results} == EXPECTED_STATUSES.keys(), results
    for item in results:
        validate_result(item)
    return results

def main():
    p=argparse.ArgumentParser(description=__doc__)
    for arg in ['baseline','candidate','output']: p.add_argument('--'+arg,type=pathlib.Path,required=True)
    p.add_argument('--cpus',default='2,4,6,8')
    args=p.parse_args(); args.output.mkdir(parents=True,exist_ok=False)
    old=run_arm(args.baseline.resolve(),args.output.resolve(),'baseline',0,[],args.cpus,run)
    new=run_arm(args.candidate.resolve(),args.output.resolve(),'candidate',0,[],args.cpus,run)
    assert len(old)==len(new)==21,(len(old),len(new))
    diffs=[{'baseline':a,'candidate':b} for a,b in zip(old,new) if a!=b]
    (args.output/'differences.json').write_text(json.dumps(diffs,indent=2))
    assert not diffs, f'{len(diffs)} differences: {args.output}/differences.json'
    print(f'{len(old)} scenarios identical across status, rows, schema and ingestion accounting')

if __name__=='__main__': main()
