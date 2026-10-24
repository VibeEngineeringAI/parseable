#!/usr/bin/env python3
"""Paced compact wide ingestion plus same-dataset COUNT queries through real HTTP capture."""
import argparse
import hashlib
import json
import math

from run import identified, verify_requests
from sustained import (CLIENT_BODY_BUDGET, HTTP_LIMIT, MAX_REQUESTS, add_arguments,
                       exercise, run_experiments, validate_arguments, workload_options)


def compact_payload(rows=8204, fields=127):
    """127 JSON fields includes both identities; Parseable inserts column 128, p_timestamp.

    f000 sorts before p_timestamp in the production query schema. Compact names and
    scalar values keep the actual default HTTP request below the 10 MiB limit.
    Construct bytes directly to avoid retaining a wide Python object graph.
    """
    prefix = b'{' + b''.join(f'"f{i:03d}":0,'.encode() for i in range(fields - 2))
    prefix += b'"request_id":"__REQUEST_ID__","row_id":'
    return b'[' + b','.join(prefix + str(i).encode() + b'}' for i in range(rows)) + b']'


def preflight(payload, rows, fields, requests, workers):
    """Check an actual encoded request, including its identity, before starting any server."""
    body = identified(payload, requests + 3)
    if len(body) >= HTTP_LIMIT:
        raise ValueError(f'HTTP body is {len(body)} bytes; must be below {HTTP_LIMIT}')
    if (workers + 2) * max(len(payload), len(body)) > CLIENT_BODY_BUDGET:
        raise ValueError('client body budget exceeded')
    decoded = json.loads(body)
    expected_id = f'{requests + 3:08d}'
    if len(decoded) != rows or any(len(row) != fields or row['request_id'] != expected_id
                                  or row['row_id'] != i for i, row in enumerate(decoded)):
        raise AssertionError('encoded body failed field/identity preflight')
    return dict(json_fields=fields, fields_including_server_timestamp=fields + 1,
                rows_per_request=rows, payload_bytes=len(body), http_limit_bytes=HTTP_LIMIT,
                payload_template_sha256=hashlib.sha256(payload).hexdigest(),
                capture_schema='production get_schema sorts fields; f000 precedes p_timestamp')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    add_arguments(parser, seconds=60, rate=2)
    parser.add_argument('--rows', type=int, default=8204)
    parser.add_argument('--fields', type=int, default=127, help='JSON fields including request_id and row_id')
    parser.add_argument('--queries-per-second', type=float, default=2)
    args = parser.parse_args()
    validate_arguments(parser, args)
    if not 1 <= args.rows <= 100000 or not 3 <= args.fields <= 1024:
        parser.error('rows must be 1..100000 and fields 3..1024')
    if (not math.isfinite(args.queries_per_second)
            or not 1 <= args.seconds * args.queries_per_second <= MAX_REQUESTS):
        parser.error('offered query count must be 1..100000')
    # Bound construction itself, even for dimensions that would fail the body check.
    if args.rows * (args.fields * 10 + 80) > CLIENT_BODY_BUDGET // 3:
        parser.error('payload construction budget exceeded')
    payload = compact_payload(args.rows, args.fields)
    try:
        metadata = preflight(payload, args.rows, args.fields,
                             int(args.seconds * args.requests_per_second), args.workers)
    except ValueError as error:
        parser.error(str(error))
    print(json.dumps(dict(preflight=metadata)), flush=True)

    def action(port, pid, output):
        result = exercise(port, pid, args.seconds, args.requests_per_second, output,
                          payload=payload, rows=args.rows, stream='benchmixed',
                          query_rate=args.queries_per_second, **workload_options(args))
        result.update(metadata)
        return result

    run_experiments(args, action,
                    lambda port: verify_requests(port, 'benchmixed', args.rows,
                                                 int(args.seconds * args.requests_per_second) + 4))


if __name__ == '__main__':
    main()
