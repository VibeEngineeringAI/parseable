#!/usr/bin/env python3
"""Fixed-work local-store comparison using the repository's disposable server harness."""
import argparse
import concurrent.futures
import datetime
import json
import pathlib
import statistics
import sys
import time

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from run import fixture, identified, request, run_arm, snapshot


def measure(port, pid, rows, clients, requests, directory):
    stream = 'smallbatch'
    payload = fixture(rows, 20, True)
    # Allocate all request identities before timing; cap client payload memory.
    assert len(payload) * requests <= 768 * 2**20, 'client payload budget exceeded'
    payloads = [identified(payload, i) for i in range(requests)]
    # Start near the beginning of a minute to avoid scheduled conversion.
    time.sleep((3 - time.time() % 60) % 60)
    before = snapshot(pid)
    wall_start = time.time()
    start = time.perf_counter()

    def worker(index):
        latencies = []
        for i in range(index, requests, clients):
            tick = time.perf_counter()
            request(port, 'POST', '/api/v1/ingest', payloads[i], stream)
            latencies.append((time.perf_counter() - tick) * 1000)
        return latencies

    with concurrent.futures.ThreadPoolExecutor(max_workers=clients) as pool:
        latencies = sorted(t for result in pool.map(worker, range(clients)) for t in result)
    elapsed = time.perf_counter() - start
    after = snapshot(pid)
    assert int(wall_start // 60) == int(time.time() // 60), 'load crossed conversion boundary; reduce --requests'
    staged = sum(p.stat().st_size for p in (directory / 'staging').rglob('*')
                 if p.is_file() and p.suffix in ('.part', '.arrows'))
    # Explicit bounds include the just-ingested current minute.
    stamp = lambda t: datetime.datetime.fromtimestamp(t, datetime.timezone.utc).isoformat()
    body = {'query': f'SELECT request_id, COUNT(*) AS n, COUNT(DISTINCT row_id) AS u FROM {stream} GROUP BY request_id ORDER BY request_id',
            'startTime': stamp(wall_start - 60), 'endTime': stamp(time.time() + 1)}
    answer = json.loads(request(port, 'POST', '/api/v1/query', json.dumps(body).encode()))
    assert answer == [{'request_id': f'{i:08d}', 'n': rows, 'u': rows} for i in range(requests)], 'request/row identity mismatch'
    total = rows * requests
    return dict(rows_per_request=rows, clients=clients, rows=total, elapsed_s=elapsed,
                rows_per_s=total / elapsed, p50_ms=statistics.median(latencies),
                p99_ms=latencies[int((len(latencies)-1)*.99)],
                cpu_per_million=(after['cpu_s']-before['cpu_s']) / total * 1e6,
                staging_bytes_per_row=staged / total, verified_rows=total)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ['baseline', 'candidate', 'output']:
        parser.add_argument('--' + name, type=pathlib.Path, required=True)
    parser.add_argument('--pairs', type=int, default=3)
    parser.add_argument('--rows', type=int, nargs='+', default=[1, 10, 100, 1000])
    parser.add_argument('--clients', type=int, default=16)
    parser.add_argument('--requests', type=int, default=1024)
    parser.add_argument('--cpus', default='')
    args = parser.parse_args()
    assert min(args.pairs, args.clients, args.requests, *args.rows) > 0
    root = args.output.resolve()
    root.mkdir(parents=True, exist_ok=False)
    for rows in args.rows:
        case = root / f'rows{rows}'
        case.mkdir()
        for pair in range(args.pairs):
            for arm in (['baseline', 'candidate'] if pair % 2 == 0 else ['candidate', 'baseline']):
                directory = case / f'pair{pair}-{arm}'
                result = run_arm(getattr(args, arm).resolve(), case, arm, pair, [], args.cpus,
                                 action=lambda port, pid: measure(port, pid, rows, args.clients, args.requests, directory))
                result.update(arm=arm, pair=pair)
                with (root / 'measurements.jsonl').open('a') as output:
                    output.write(json.dumps(result) + '\n')
                print(json.dumps(result), flush=True)


if __name__ == '__main__':
    main()
