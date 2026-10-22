#!/usr/bin/env python3
"""Disposable real-server dashboard-agent lifecycle and concurrency smoke.

Requires dashboard-agent writes enabled on the target server. Creates uniquely
named dashboards/datasets and removes only those resources in finally blocks.
No queries run during configuration validation or change preview.
"""
import base64
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
from threading import Barrier
import time
import urllib.error
import urllib.request
import uuid

BASE = os.environ.get('PARSEABLE_URL', 'http://127.0.0.1:9084').rstrip('/')
AUTH = base64.b64encode((os.environ.get('P_USERNAME', 'admin') + ':' + os.environ.get('P_PASSWORD', 'admin')).encode()).decode()
PREFIX = '/api/v1/dashboards'
TOOLS = '/api/prism/v1/llm/tools'


def request(path, method='GET', body=None, headers=None):
    hdr = {'Authorization': 'Basic ' + AUTH, 'Accept': 'application/json', **(headers or {})}
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        hdr['Content-Type'] = 'application/json'
    req = urllib.request.Request(BASE + path, data=data, method=method, headers=hdr)
    try:
        with urllib.request.urlopen(req, timeout=40) as res:
            raw = res.read()
            try:
                value = json.loads(raw) if raw else None
            except (ValueError, UnicodeError):
                value = raw.decode(errors='replace')
            return res.status, value, dict(res.headers)
    except urllib.error.HTTPError as exc:
        raw = exc.read()
        try:
            value = json.loads(raw)
        except (ValueError, UnicodeError):
            value = raw.decode(errors='replace')
        return exc.code, value, dict(exc.headers)


def ok(path, method='GET', body=None, headers=None):
    status, result, response_headers = request(path, method, body, headers)
    assert status == 200, (method, path, status, result)
    return result, response_headers


def tool(name, args, expect_error=False):
    value, _ = ok(TOOLS + '/call', 'POST', {'name': name, 'arguments': args})
    assert value['isError'] is expect_error, (name, value)
    return value['structuredContent']['error' if expect_error else 'result']


def ulid():
    value = int.from_bytes(uuid.uuid4().bytes, 'big')
    result = ''
    alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
    for _ in range(26):
        result = alphabet[value & 31] + result
        value >>= 5
    return result


def operation(op, target, path='', value=None):
    result = {'op': op, 'target': target, 'path': path}
    if op != 'remove':
        result['value'] = value
    return result


def main():
    suffix = uuid.uuid4().hex[:12]
    dashboard_id = None
    stream = 'agent_dashboard_' + suffix
    metrics = stream + '_metrics'
    created_streams = []
    start = datetime.now(timezone.utc) - timedelta(minutes=5)
    end = datetime.now(timezone.utc) + timedelta(minutes=1)
    counters = {'sameRevisionWinners': 0, 'sameRevisionConflicts': 0}
    try:
        caps = tool('get_dashboard_capabilities', {})
        assert caps['permissions']['agentWritesEnabled'], 'Start server with P_DASHBOARD_AGENT_WRITES=true'
        spec, _ = ok(TOOLS + '/list')
        names = {entry['name'] for entry in spec['tools']}
        assert {'create_dashboard', 'update_dashboard', 'delete_dashboard', 'preview_dashboard_changes', 'run_dashboard_queries'} <= names
        assert 'create_alert' not in names, 'Dashboard policy must not enable unrelated action tools'
        for dataset in [stream]:
            ok('/api/v1/logstream/' + dataset, 'PUT')
            created_streams.append(dataset)
        records = [{'service': 'api', 'level': 'error' if i % 4 == 0 else 'info', 'duration_ms': 10 + i} for i in range(20)]
        ok('/api/v1/ingest', 'POST', records, {'X-P-Stream': stream})
        now_ns = time.time_ns() - 1_000_000_000
        metric_query = '{__name__="dashboard_requests",service="api"}'
        otlp = {'resourceMetrics': [{'resource': {'attributes': [{'key': 'service.name', 'value': {'stringValue': 'api'}}]}, 'scopeMetrics': [{'metrics': [{'name': 'dashboard_requests', 'gauge': {'dataPoints': [{'timeUnixNano': str(now_ns), 'asDouble': 20.0, 'attributes': [{'key': 'service', 'value': {'stringValue': 'api'}}]}]}}]}]}]}
        status, value, _ = request('/v1/metrics', 'POST', otlp, {'X-P-Stream': metrics})
        assert status in [200, 202], (status, value)
        created_streams.append(metrics)
        create_args = {'dashboard': {'title': 'Agent health ' + suffix, 'dataset': stream, 'tiles': [], 'customExtension': {'preserve': True}}, 'idempotencyKey': 'create-' + suffix}
        created = tool('create_dashboard', create_args)
        dashboard_id = created['dashboard']['dashboardId']
        replayed = tool('create_dashboard', create_args)
        assert replayed['dashboard']['dashboardId'] == dashboard_id and replayed['replayed']
        document, headers = ok(PREFIX + '/' + dashboard_id)
        assert {key.lower(): value for key, value in headers.items()}.get('etag') == '"' + document['revision'] + '"', headers
        section_id, sql_id, builder_id, promql_id = [ulid() for _ in range(4)]
        ids = [sql_id, builder_id, promql_id]
        tiles = [
            {'tile_id': sql_id, 'title': 'Requests per minute', 'tileType': 'code', 'chartType': 'timeseries', 'dbName': [stream], 'chartQuery': 'SELECT DATE_TRUNC(\'minute\', p_timestamp) AS time, COUNT(*) AS requests FROM "' + stream + '" WHERE service = \'$service\' GROUP BY time ORDER BY time', 'sectionId': section_id, 'layout': {'x': 0, 'y': 0, 'w': 6, 'h': 4}, 'config': {'type': 'line', 'colourScheme': 'classic', 'axes': {'x': {'field': 'time'}, 'y': {'field': 'requests'}}, 'layout': {'legendPosition': 'bottom'}}},
            {'tile_id': builder_id, 'title': 'Errors by service', 'tileType': 'builder', 'chartType': 'table', 'dbName': [stream], 'chartQuery': {'x': {'fields': [{'name': 'service'}], 'groupBy': []}, 'y': {'fields': [{'name': '*', 'aggregate': 'COUNT'}], 'groupBy': [], 'limit': 100}, 'filters': [{'column': 'level', 'operator': '=', 'value': 'error', 'type': 'string'}]}, 'sectionId': section_id, 'layout': {'x': 6, 'y': 0, 'w': 6, 'h': 4}, 'config': {'type': 'table'}},
            {'tile_id': promql_id, 'title': 'Live request metric', 'tileType': 'promql', 'chartType': 'query-value', 'dbName': metrics, 'chartQuery': [metric_query], 'promqlQueryType': ['instant'], 'layout': {'x': 0, 'y': 0, 'w': 6, 'h': 4}, 'config': {'type': 'query-value', 'layout': {'sparkline': False}}},
        ]
        ops = [operation('add', {'type': 'section', 'id': section_id}, value={'title': 'Application health', 'collapsed': False}), operation('add', {'type': 'variable', 'name': 'service'}, value={'label': 'Service', 'type': 'list', 'options': ['api'], 'defaultValue': 'api'})]
        ops += [operation('add', {'type': 'tile', 'id': tile['tile_id']}, value=tile) for tile in tiles]
        ops += [operation('add', {'type': 'dashboard'}, '/refreshInterval', 30000), operation('add', {'type': 'dashboard'}, '/timeRange', {'type': 'fixed', 'startTime': '1h', 'endTime': 'now', 'interval': 3600000, 'shiftInterval': 1})]
        args = {'dashboardId': dashboard_id, 'revision': document['revision'], 'operations': ops}
        preview = tool('preview_dashboard_changes', args)
        assert preview['validation']['valid'] and len(preview['dashboard']['tiles']) == 3
        unchanged, _ = ok(PREFIX + '/' + dashboard_id)
        assert unchanged['revision'] == document['revision'] and unchanged['tiles'] == []
        updated = tool('update_dashboard', {**args, 'idempotencyKey': 'configure-' + suffix})
        replay = tool('update_dashboard', {**args, 'idempotencyKey': 'configure-' + suffix})
        assert replay['replayed'] and len(replay['dashboard']['tiles']) == 3
        document = updated['dashboard']
        assert document['customExtension'] == {'preserve': True} and '_parseableDashboard' not in document
        invalid = [operation('replace', {'type': 'dashboard'}, '/title', 'should-not-save'), operation('replace', {'type': 'tile', 'id': sql_id}, '/layout/w', 13)]
        error = tool('update_dashboard', {'dashboardId': dashboard_id, 'revision': document['revision'], 'operations': invalid, 'idempotencyKey': 'invalid-' + suffix}, expect_error=True)
        assert error['status'] == 422, error
        after_invalid, _ = ok(PREFIX + '/' + dashboard_id)
        assert after_invalid == document, 'Invalid final candidate partially committed'
        protected = [operation('replace', {'type': 'dashboard'}, '/tenantId', 'another-tenant')]
        error = tool('update_dashboard', {'dashboardId': dashboard_id, 'revision': document['revision'], 'operations': protected, 'idempotencyKey': 'protected-' + suffix}, expect_error=True)
        assert error['status'] in [400, 422], error
        barrier = Barrier(24)
        timings = []

        def contend(index):
            barrier.wait(timeout=10)
            began = time.perf_counter()
            result = request(PREFIX + '/' + dashboard_id, 'PATCH', {'operations': [operation('replace', {'type': 'tile', 'id': sql_id}, '/title', 'Request rate ' + str(index))]}, {'If-Match': '"' + document['revision'] + '"'})
            return result[0], (time.perf_counter() - began) * 1000

        with ThreadPoolExecutor(max_workers=24) as pool:
            for status, elapsed in pool.map(contend, range(24)):
                assert status in [200, 412], status
                counters['sameRevisionWinners' if status == 200 else 'sameRevisionConflicts'] += 1
                timings.append(elapsed)
        assert counters['sameRevisionWinners'] == 1 and counters['sameRevisionConflicts'] == 23, counters

        def add_from_agent(index):
            tile_id = ulid()
            tile = {**tiles[2], 'tile_id': tile_id, 'title': 'Agent counter ' + str(index), 'layout': {'x': 0, 'y': 4 + index * 4, 'w': 6, 'h': 4}}
            for attempt in range(40):
                base, _ = ok(PREFIX + '/' + dashboard_id)
                status, result, _ = request(PREFIX + '/' + dashboard_id, 'PATCH', {'operations': [operation('add', {'type': 'tile', 'id': tile_id}, value=tile)]}, {'If-Match': '"' + base['revision'] + '"', 'Idempotency-Key': 'append-' + suffix + '-' + str(index)})
                if status == 200:
                    return tile_id
                assert status == 412, (status, result)
                time.sleep(min(.002 * (attempt + 1), .03))
            raise AssertionError('Concurrent agent retry budget exhausted')

        with ThreadPoolExecutor(max_workers=8) as pool:
            added_ids = list(pool.map(add_from_agent, range(8)))
        document, _ = ok(PREFIX + '/' + dashboard_id)
        stored_ids = [tile['tile_id'] for tile in document['tiles']]
        assert len(stored_ids) == 11 and len(set(stored_ids)) == 11 and set(added_ids) <= set(stored_ids)
        rename = [{'op': 'renameVariable', 'from': 'service', 'to': 'application'}, {'op': 'placeTile', 'tileId': promql_id, 'sectionId': section_id, 'layout': {'x': 0, 'y': 4, 'w': 12, 'h': 4}}]
        document = tool('update_dashboard', {'dashboardId': dashboard_id, 'revision': document['revision'], 'operations': rename, 'idempotencyKey': 'rename-' + suffix})['dashboard']
        assert '$application' in document['tiles'][0]['chartQuery'] and '$service' not in document['tiles'][0]['chartQuery']
        runtime = {'dashboardId': dashboard_id, 'revision': document['revision'], 'tileIds': ids, 'startTime': start.isoformat(), 'endTime': end.isoformat(), 'variables': {'application': 'api'}}
        deadline = time.monotonic() + 30
        while True:
            result = tool('run_dashboard_queries', runtime)
            successful = all(item['status'] == 'success' for item in result['results'])
            rows_present = successful and all(item.get('rows') for item in result['results'] if item['tileId'] in [sql_id, builder_id])
            promql_present = successful and any(item.get('promql', [{}])[0].get('instant', {}).get('result') for item in result['results'] if item['tileId'] == promql_id)
            if successful and rows_present and promql_present:
                break
            assert time.monotonic() < deadline, result
            time.sleep(.5)
        assert len(result['results']) == 3
        assert rows_present and promql_present, result
        executed = {item['tileId']: item for item in result['results']}
        assert sum(row['requests'] for row in executed[sql_id]['rows']) == 20, result
        assert executed[builder_id]['rows'][0]['COUNT_STAR'] == 5, result
        assert float(executed[promql_id]['promql'][0]['instant']['result'][0]['value'][1]) == 20.0, result
        assert result['revision'] == document['revision']
        untouched, _ = ok(PREFIX + '/' + dashboard_id)
        assert untouched == document, 'Runtime preview mutated configuration'
        timings.sort()
        counters['sameRevisionLatencyMsP50'] = round(timings[len(timings)//2], 2)
        counters['sameRevisionLatencyMsMax'] = round(timings[-1], 2)
        counters['concurrentRebasedAdditions'] = 8
        counters['runtimeTiles'] = len(result['results'])
        counters['dashboardId'] = dashboard_id
        counters['status'] = 'passed'
        output = os.environ.get('DASHBOARD_AGENT_REPORT')
        if output:
            Path(output).write_text(json.dumps({'checks': counters, 'dashboard': document, 'runtime': result}, indent=2))
        print(json.dumps(counters))
    finally:
        if dashboard_id:
            status, document, _ = request(PREFIX + '/' + dashboard_id)
            if status == 200:
                status, result, _ = request(PREFIX + '/' + dashboard_id, 'DELETE', headers={'If-Match': '"' + document['revision'] + '"'})
                assert status == 200, ('cleanup-dashboard', status, result)
        for stream in reversed(created_streams):
            status, result, _ = request('/api/v1/logstream/' + stream, 'DELETE')
            assert status in [200, 404], ('cleanup-dataset', status, result)


if __name__ == '__main__':
    main()
