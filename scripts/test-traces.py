#!/usr/bin/env python3
"""Read-only trace list regression against a disposable server with OTLP data.

Execute the checked-in Rust SQL template through the live DataFusion query API:
  PARSEABLE_LIVE_USERNAME=fixture PARSEABLE_LIVE_PASSWORD=fixture-throwaway \
    python scripts/test-traces.py --url http://127.0.0.1:8450 \
      --dataset otel-traces-fixture

Add --handler to test the compiled /services/traces/list handler instead.
The default validates SQL semantics; it does not claim the server binary was rebuilt.
No datasets are created, changed or deleted.
"""

import argparse
import base64
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import re
import urllib.request


def identifier(value):
    return '"' + value.replace('"', '""') + '"'


def literal(value):
    return "'" + value.replace("'", "''") + "'"


def timestamp(value):
    parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
    return parsed.replace(tzinfo=timezone.utc) if parsed.tzinfo is None else parsed.astimezone(timezone.utc)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url', required=True)
    parser.add_argument('--dataset', required=True)
    parser.add_argument('--handler', action='store_true')
    args = parser.parse_args()
    user = os.environ['PARSEABLE_LIVE_USERNAME']
    password = os.environ['PARSEABLE_LIVE_PASSWORD']
    auth = base64.b64encode(f'{user}:{password}'.encode()).decode()
    now = datetime.now(timezone.utc).replace(second=0, microsecond=0)
    # The query engine floors both bounds to minutes. Include the current minute
    # so a freshly ingested fixture is visible without waiting for the next minute.
    start, end = (now - timedelta(days=1)).isoformat(), (now + timedelta(minutes=1)).isoformat()

    def post(path, body):
        request = urllib.request.Request(
            args.url.rstrip('/') + path,
            data=json.dumps(body).encode(),
            headers={'Authorization': f'Basic {auth}', 'Content-Type': 'application/json'},
        )
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.load(response)

    def query(sql):
        return post('/api/v1/query', {'query': sql, 'startTime': start, 'endTime': end, 'sendNull': True})

    table = identifier(args.dataset)
    source_filter = f't."p_timestamp" >= TIMESTAMP {literal(start)} AND t."p_timestamp" <= TIMESTAMP {literal(end)} AND t."service.name" IS NOT NULL'
    raw = query(f'SELECT * FROM {table} t WHERE {source_filter} LIMIT 10000')
    assert raw and len(raw) < 10000, 'A nonempty, bounded fixture is required'
    groups = {}
    for row in raw:
        groups.setdefault((row['span_trace_id'], row['span_span_id']), []).append(row)
    assert any(len({row['p_timestamp'] for row in copies}) > 1 for copies in groups.values()), 'Fixture must include replayed spans with different ingestion timestamps'
    fields = ['service.name', 'span_name', 'span_duration_ns', 'span_trace_id', 'span_span_id', 'span_start_time_unix_nano', 'span_start_time_unix_nano_epoch']
    expected = {}
    for row in raw:
        copies = groups[(row['span_trace_id'], row['span_span_id'])]
        trace = [other for other in raw if other['span_trace_id'] == row['span_trace_id']]
        projection = {key: row[key] for key in fields}
        projection.update(
            p_timestamp=min(copies, key=lambda copy: timestamp(copy['p_timestamp']))['p_timestamp'],
            total_span_count=len({other['span_span_id'] for other in trace}),
            error_count=len({other['span_span_id'] for other in trace if other.get('span_status_code') == 2}),
        )
        expected[json.dumps(projection, sort_keys=True)] = (projection, row)

    source = (Path(__file__).resolve().parents[1] / 'src/handlers/http/traces.rs').read_text()
    body = source.split('fn build_trace_list_sql(', 1)[1].split('fn build_trace_count_sql(', 1)[0]
    template = re.search(r'r#"([\s\S]+?)"#', body).group(1)
    sorts = {
        'mostRecent': ('span_start_time_unix_nano_epoch', 'DESC'),
        'leastRecent': ('span_start_time_unix_nano_epoch', 'ASC'),
        'longestFirst': ('span_duration_ns', 'DESC'),
        'shortestFirst': ('span_duration_ns', 'ASC'),
        'mostSpans': ('total_span_count', 'DESC'),
        'leastSpans': ('total_span_count', 'ASC'),
    }
    options = {
        'traces': ("COALESCE(span_parent_span_id, '') = ''", lambda row: not row.get('span_parent_span_id')),
        'errorSpans': ('error_count > 0 AND span_status_code = 2', lambda row: row.get('span_status_code') == 2),
        'spans': ('1=1', lambda row: True),
    }
    cases = 0
    for option, (result_filter, eligible) in options.items():
        selected = [projection for projection, original in expected.values() if eligible(original)]
        count = len({row['span_span_id'] for row in raw if eligible(row)})
        assert len(selected) == count, 'Fixture has conflicting span metadata; timestamp normalization cannot resolve those conflicts'
        for sort, (sort_column, sort_direction) in sorts.items():
            def read(offset=0, limit=500):
                if args.handler:
                    return post('/api/prism/v1/services/traces/list', dict(dataset=args.dataset, startTime=start, endTime=end, options=option, sortBy=sort, offset=offset, limit=limit))
                sql = template.format(table=table, source_filter=source_filter, result_filter=result_filter, sort_column=sort_column, sort_direction=sort_direction, offset=offset, limit=limit)
                return {'count': count, 'records': query(sql)}

            response = read()
            records = response['records']
            assert response['count'] == count == len(records), (option, sort, response['count'], len(records))
            assert {json.dumps(row, sort_keys=True) for row in records} == {json.dumps(row, sort_keys=True) for row in selected}, (option, sort, 'projection mismatch')
            ordered = sorted(selected, key=lambda row: row['span_span_id'])
            ordered.sort(key=lambda row: row['span_start_time_unix_nano_epoch'], reverse=True)
            ordered.sort(key=lambda row: row[sort_column], reverse=sort_direction == 'DESC')
            assert records == ordered, (option, sort, 'sort mismatch')
            paged = [row for offset in range(count) for row in read(offset, 1)['records']]
            assert paged == records, (option, sort, 'pagination mismatch')
            assert not read(count, 1)['records'], (option, sort, 'past-end page')
            cases += 1
    mode = 'compiled handler' if args.handler else 'checked-in SQL template through live DataFusion'
    print(json.dumps({'validation': mode, 'cases': cases, 'rawRows': len(raw), 'uniqueSpans': len(groups), 'dataset': args.dataset}))


if __name__ == '__main__':
    main()
