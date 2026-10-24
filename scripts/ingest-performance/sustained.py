#!/usr/bin/env python3
"""Paced local-store qualification: equal offered rate, background work enabled."""
import argparse
import bisect
import concurrent.futures
import hashlib
import http.client
import json
import math
import os
import pathlib
import platform
import sys
import threading
import time

from diagnostic import Diagnostics
from run import fixture, identified, request, run_arm, snapshot, verify_requests


HTTP_LIMIT = 10 * 2**20
MAX_REQUESTS = 100_000
CLIENT_BODY_BUDGET = 128 * 2**20


def file_sha256(path):
    digest = hashlib.sha256()
    with path.open('rb') as source:
        for chunk in iter(lambda: source.read(2**20), b''):
            digest.update(chunk)
    return digest.hexdigest()


def observation(index, due, start, end, anchor):
    """Wall due time is projected once; actual wall times reveal clock adjustments."""
    mono, wall = anchor
    return dict(request=index, due_monotonic_s=due, start_monotonic_s=start[0],
                end_monotonic_s=end[0], due_wall_s=wall + due - mono,
                start_wall_s=start[1], end_wall_s=end[1], latency_s=end[0] - start[0],
                scheduled_latency_s=end[0] - due, lag_s=start[0] - due)


def latency_summary(observations, key='latency_s'):
    values = sorted(o[key] * 1000 for o in observations)
    if not values:
        return {}
    # Preserve the legacy lower-index empirical quantile definition.
    result = {name + '_ms': values[int(q * (len(values) - 1))]
              for name, q in [('p50', .5), ('p95', .95), ('p99', .99), ('p99_9', .999)]}
    result['max_ms'] = values[-1]
    return result


def validate_query_counts(queries, observations, rows, warmup):
    """Conservative visibility bounds, evaluated outside timed HTTP work."""
    acknowledged = sorted(o['end_monotonic_s'] for o in observations if o['accepted'])
    started = sorted(o['start_monotonic_s'] for o in observations)
    invalid = []
    for query in queries:
        lower = (warmup + bisect.bisect_left(acknowledged, query['start_monotonic_s'])) * rows
        upper = (warmup + bisect.bisect_right(started, query['end_monotonic_s'])) * rows
        query.update(min_visible_rows=lower, max_visible_rows=upper)
        if query['error'] is None and not lower <= query['count'] <= upper:
            query.update(error=repr(('count outside acknowledgment bounds', query['count'], lower, upper)),
                         error_kind='count')
            invalid.append(query['request'])
    if invalid:
        raise AssertionError(('concurrent query visibility failed', invalid))


def staging_backlog(root, stream):
    files = []
    for path in (root / 'staging' / stream).rglob('*'):
        try:
            if path.is_file() and (path.suffix in ('.arrows', '.parquet', '.part') or 'inprocess' in path.parts):
                if path.stat().st_size:
                    files.append(str(path))
        except FileNotFoundError:
            pass
    return files


def drain(root, stream, timeout):
    started, empty = time.monotonic(), 0
    while time.monotonic() - started < timeout:
        backlog = staging_backlog(root, stream)
        empty = empty + 1 if not backlog else 0
        if empty >= 3:
            return time.monotonic() - started
        time.sleep(min(2, max(0, timeout - (time.monotonic() - started))))
    raise AssertionError(('staging did not drain', backlog[:10]))


def exercise(port, pid, seconds, rate, output, *, payload, rows, stream,
             workers=4, query_rate=0, diagnostics=False, diagnostic_max_bytes=256 * 2**20,
             phase_align=True, max_lag=30, request_timeout=90, drain_timeout=240,
             max_staging_bytes=4096 * 2**20):
    count = int(seconds * rate)
    warmup = 4
    body_bytes = len(identified(payload, count + warmup - 1))
    if body_bytes >= HTTP_LIMIT:
        raise ValueError(f'HTTP body {body_bytes} bytes must be below {HTTP_LIMIT}')
    if (workers + 2) * max(len(payload), body_bytes) > CLIENT_BODY_BUDGET:
        raise ValueError('client body budget exceeded')
    root = pathlib.Path(os.readlink(f'/proc/{pid}/cwd'))
    binary_hash = file_sha256(pathlib.Path(os.readlink(f'/proc/{pid}/exe')))
    for i in range(warmup):
        conn = http.client.HTTPConnection('127.0.0.1', port, timeout=request_timeout)
        try:
            request(port, 'POST', '/api/v1/ingest', identified(payload, i), stream, conn)
        finally:
            conn.close()

    anchor = (time.monotonic(), time.time())
    start = anchor[0] + 1
    if phase_align:
        # Align offered load after warmup, so warmup cost cannot shift the
        # compared arms' exposure to periodic conversion/upload work.
        start += (5 - (anchor[1] + 1) % 60) % 60
    deadline = start + seconds + max_lag + request_timeout
    stop, abort = threading.Event(), threading.Event()
    observations, queries, samples, errors = [], [], [], []
    phase = ['before_load']
    diag = Diagnostics(pid, output.with_name(output.stem + '-diagnostic.jsonl'),
                       max_bytes=diagnostic_max_bytes) if diagnostics else None

    def monitor():
        try:
            while not stop.is_set():
                sample = dict(snapshot(pid), elapsed_s=time.monotonic() - start,
                              monotonic_s=time.monotonic(), wall_s=time.time(), phase=phase[0],
                              client=snapshot(os.getpid()))
                for folder in ('staging', 'data'):
                    sizes = []
                    for file in (root / folder).rglob('*'):
                        try:
                            if file.is_file():
                                sizes.append(file.stat().st_size)
                        except FileNotFoundError:
                            pass
                    sample[folder + '_bytes'] = sum(sizes)
                    sample[folder + '_files'] = len(sizes)
                samples.append(sample)
                if sample['staging_bytes'] > max_staging_bytes:
                    raise RuntimeError('staging byte safety bound reached; qualification incomplete')
                stop.wait(1)
        except Exception as error:
            errors.append(repr(error))
            abort.set()

    def wait_due(due):
        if abort.wait(max(0, due - time.monotonic())):
            raise RuntimeError('workload aborted by another worker')
        now = time.monotonic()
        if now - due > max_lag or now > deadline:
            raise RuntimeError('paced backlog/time safety bound reached; qualification incomplete')

    def worker(index):
        conn = http.client.HTTPConnection('127.0.0.1', port, timeout=request_timeout)
        try:
            for i in range(index, count, workers):
                body = identified(payload, i + warmup)
                due = start + i / rate
                wait_due(due)
                began = (time.monotonic(), time.time())
                error = None
                try:
                    request(port, 'POST', '/api/v1/ingest', body, stream, conn)
                except Exception as exc:
                    error = repr(exc)
                    raise
                finally:
                    item = observation(i, due, began, (time.monotonic(), time.time()), anchor)
                    item.update(request_id=f'{i + warmup:08d}', accepted=error is None, error=error)
                    observations.append(item)
        except Exception:
            abort.set()
            raise
        finally:
            conn.close()

    def query_worker():
        conn = http.client.HTTPConnection('127.0.0.1', port, timeout=request_timeout)
        body = json.dumps(dict(query=f'SELECT count(*) AS n FROM {stream}',
                               startTime='1h', endTime='now')).encode()
        try:
            for i in range(int(seconds * query_rate)):
                due = start + i / query_rate
                wait_due(due)
                began = (time.monotonic(), time.time())
                error, kind, n = None, None, None
                try:
                    reply = json.loads(request(port, 'POST', '/api/v1/query', body, connection=conn))
                    kind = 'count'
                    if not (isinstance(reply, list) and len(reply) == 1 and isinstance(reply[0], dict)):
                        raise AssertionError(('invalid count response', reply))
                    n = reply[0].get('n')
                    # Full timestamp-based visibility bounds run after load.
                    if type(n) is not int or not 0 <= n <= (count + warmup) * rows:
                        raise AssertionError(('invalid count value', n))
                    kind = None
                except Exception as exc:
                    error, kind = repr(exc), kind or 'http_or_decode'
                    raise
                finally:
                    item = observation(i, due, began, (time.monotonic(), time.time()), anchor)
                    item.update(count=n, error=error, error_kind=kind)
                    queries.append(item)
        except Exception:
            abort.set()
            raise
        finally:
            conn.close()

    monitor_thread = threading.Thread(target=monitor, name='resource-monitor')
    before = after = after_drain = client_before = client_after = None
    elapsed = drain_seconds = None
    result = dict(duration_s=seconds, rows_per_request=rows, requests=count, workers=workers,
                  offered_start_wall_s=anchor[1] + start - anchor[0],
                  offered_rows_per_s=rate * rows, query_requests_per_s=query_rate,
                  payload_bytes=body_bytes, payload_sha256=hashlib.sha256(payload).hexdigest(),
                  warmup_requests=warmup, diagnostics_enabled=diagnostics,
                  load_cpu_scope='ingestion and concurrent queries' if query_rate else 'ingestion',
                  safety_bounds=dict(max_lag_s=max_lag, request_timeout_s=request_timeout,
                                     drain_timeout_s=drain_timeout, max_staging_bytes=max_staging_bytes,
                                     client_body_budget_bytes=CLIENT_BODY_BUDGET),
                  binary_sha256=binary_hash)
    try:
        monitor_thread.start()
        if diag:
            diag.start()
        with concurrent.futures.ThreadPoolExecutor(max_workers=workers + bool(query_rate)) as pool:
            futures = [pool.submit(worker, i) for i in range(workers)]
            if query_rate:
                futures.append(pool.submit(query_worker))
            try:
                abort.wait(max(0, start - time.monotonic()))
                phase[0] = 'load'
                before, client_before = snapshot(pid), snapshot(os.getpid())
                for future in concurrent.futures.as_completed(futures):
                    future.result()
            except BaseException:
                abort.set()
                raise
        elapsed = time.monotonic() - start
        after, client_after = snapshot(pid), snapshot(os.getpid())
        if len(observations) != count or any(not o['accepted'] for o in observations):
            raise AssertionError('incomplete accepted request accounting')
        if query_rate and len(queries) != int(seconds * query_rate):
            raise AssertionError('incomplete query accounting')
        if errors:
            raise RuntimeError(errors)
        validate_query_counts(queries, observations, rows, warmup)
        phase[0] = 'verify_after_load'
        verify_requests(port, stream, rows, count + warmup)
        phase[0] = 'drain'
        drain_before = snapshot(pid)
        drain_seconds = drain(root, stream, drain_timeout)
        after_drain = snapshot(pid)
        result['drain_cpu_s'] = after_drain['cpu_s'] - drain_before['cpu_s']
        phase[0] = 'verify_after_drain'
        verify_requests(port, stream, rows, count + warmup)
        result['verified_rows_before_and_after_drain'] = (count + warmup) * rows
        result['verified_unique_request_rows'] = True
    except BaseException as error:
        abort.set()
        result['error'] = repr(error)
        raise
    finally:
        stop.set()
        if monitor_thread.ident is not None:
            monitor_thread.join()
        if diag and diag.thread.ident is not None:
            result['diagnostics'] = diag.close()
        accepted = [o for o in observations if o['accepted']]
        result.update(accepted_requests=len(accepted), accepted_rows=len(accepted) * rows,
                      observations_recorded=len(observations), query_requests=len(queries),
                      query_errors=sum(q['error'] is not None for q in queries),
                      query_count_errors=sum(q['error_kind'] == 'count' for q in queries),
                      query_http_or_decode_errors=sum(q['error_kind'] == 'http_or_decode' for q in queries),
                      monitor_errors=errors, elapsed_s=elapsed, drain_wait_s=drain_seconds,
                      drain_scope='target dataset staging; persisted-only restart verifies rows',
                      samples=samples, loadavg_end=os.getloadavg())
        result.update(latency_summary(accepted))
        result.update({'scheduled_' + k: v for k, v in latency_summary(accepted, 'scheduled_latency_s').items()})
        result['query_latency'] = latency_summary(queries)
        result['query_scheduled_latency'] = latency_summary(queries, 'scheduled_latency_s')
        if accepted:
            result['ingest_elapsed_s'] = max(o['end_monotonic_s'] for o in accepted) - start
        if observations:
            result['max_schedule_lag_ms'] = max(o['lag_s'] for o in observations) * 1000
        if samples:
            result['peak_rss_bytes'] = max(s['rss_bytes'] for s in samples)
            result['client_peak_rss_bytes'] = max(s['client']['rss_bytes'] for s in samples)
            for stage in ('load', 'drain'):
                selected = [s for s in samples if s['phase'] == stage]
                result[stage + '_peak_rss_bytes'] = max((s['rss_bytes'] for s in selected), default=None)
        if before and after and elapsed is not None:
            cpu = after['cpu_s'] - before['cpu_s']
            result.update(cpu_s=cpu, cpu_us_per_row=cpu * 1e6 / (count * rows),
                          accepted_rows_per_s=count * rows / elapsed,
                          client_load_cpu_s=client_after['cpu_s'] - client_before['cpu_s'])
        if before and after_drain:
            cpu = after_drain['cpu_s'] - before['cpu_s']
            result.update(cpu_including_drain_s=cpu,
                          cpu_including_drain_us_per_row=cpu * 1e6 / (count * rows))
        output.write_text(json.dumps(dict(observations=sorted(observations, key=lambda o: o['request']),
                                          query_observations=queries, result=result), indent=2))
    if errors or (diag and diag.errors):
        raise RuntimeError(errors + diag.errors if diag else errors)
    return result


def test(port, pid, seconds, rate, output, **options):
    return exercise(port, pid, seconds, rate, output, payload=fixture(1000, 20, True),
                    rows=1000, stream='benchsustained', **options)


def add_arguments(parser, *, seconds=300, rate=20):
    parser.add_argument('--baseline', type=pathlib.Path, required=True)
    candidate = parser.add_mutually_exclusive_group(required=True)
    candidate.add_argument('--candidate', type=pathlib.Path)
    candidate.add_argument('--fixed', type=pathlib.Path, help='label the candidate arm fixed')
    parser.add_argument('--reviewed', type=pathlib.Path, help='optional third, pre-fix reviewed binary')
    parser.add_argument('--output', type=pathlib.Path, required=True)
    parser.add_argument('--seconds', type=int, default=seconds)
    parser.add_argument('--requests-per-second', type=float, default=rate)
    parser.add_argument('--pairs', type=int, default=1)
    parser.add_argument('--cpus', default='2,4,6,8')
    parser.add_argument('--workers', type=int, default=4)
    parser.add_argument('--diagnostics', action='store_true', help='100 ms bounded process/thread/host diagnostics in every arm')
    parser.add_argument('--diagnostic-max-mib', type=int, default=256)
    parser.add_argument('--max-lag-seconds', type=float, default=30, help='abort incomplete workloads at this client backlog bound')
    parser.add_argument('--request-timeout', type=float, default=90)
    parser.add_argument('--drain-timeout', type=float, default=240)
    parser.add_argument('--max-staging-mib', type=int, default=4096)
    parser.add_argument('--no-phase-align', action='store_true', help='skip alignment to wall-clock minute :05')


def validate_arguments(parser, args):
    if not 1 <= args.seconds <= 3600 or not 1 <= args.pairs <= 100:
        parser.error('seconds must be 1..3600 and pairs 1..100')
    if not math.isfinite(args.requests_per_second) or not 1 <= args.seconds * args.requests_per_second <= MAX_REQUESTS:
        parser.error('offered request count must be 1..100000')
    if not 1 <= args.workers <= 16 or not 1 <= args.diagnostic_max_mib <= 1024:
        parser.error('workers must be 1..16 and diagnostic-max-mib 1..1024')
    for value in (args.max_lag_seconds, args.request_timeout, args.drain_timeout):
        if not math.isfinite(value) or not 0 < value <= 600:
            parser.error('lag/HTTP/drain bounds must be finite and in (0,600] seconds')
    if not 1 <= args.max_staging_mib <= 65536:
        parser.error('max-staging-mib must be 1..65536')
    if args.seconds + args.max_lag_seconds + args.request_timeout + args.drain_timeout + 360 >= 3600:
        parser.error('load/drain bounds must leave verification/restart within the oracle one-hour window')


def run_experiments(args, action, persisted_check):
    args.output.mkdir(parents=True, exist_ok=False)
    root = args.output.resolve()
    arms = ['baseline'] + (['reviewed'] if args.reviewed else []) + ['fixed' if args.fixed else 'candidate']
    orders = [arms if pair % 2 == 0 else arms[::-1] for pair in range(args.pairs)]
    manifest = dict(arguments={k: str(v) if isinstance(v, pathlib.Path) else v for k, v in vars(args).items()},
                    command=sys.argv, python=sys.version, host=platform.uname()._asdict(), arm_orders=orders,
                    sources={p.name: hashlib.sha256(p.read_bytes()).hexdigest()
                             for p in pathlib.Path(__file__).parent.glob('*.py')})
    (root / 'experiment.json').write_text(json.dumps(manifest, indent=2))
    for pair, order in enumerate(orders):
        for arm in order:
            # The historical one-pair filenames remain consumable by plot.py.
            name = arm if args.pairs == 1 else f'pair{pair}-{arm}'
            output = root / (name + '-samples.json')
            result = run_arm(getattr(args, arm).resolve(), root, arm, pair, [], args.cpus,
                             lambda port, pid: action(port, pid, output),
                             persisted_restart_check=persisted_check)
            result.update(arm=arm, pair=pair, arm_order=order)
            document = json.loads(output.read_text())
            document['result'] = result
            output.write_text(json.dumps(document, indent=2))
            with (root / 'measurements.jsonl').open('a') as out:
                out.write(json.dumps({k: v for k, v in result.items() if k != 'samples'}) + '\n')
            print(json.dumps({k: v for k, v in result.items() if k != 'samples'}, indent=2), flush=True)


def workload_options(args):
    return dict(workers=args.workers, diagnostics=args.diagnostics,
                diagnostic_max_bytes=args.diagnostic_max_mib * 2**20,
                phase_align=not args.no_phase_align, max_lag=args.max_lag_seconds,
                request_timeout=args.request_timeout, drain_timeout=args.drain_timeout,
                max_staging_bytes=args.max_staging_mib * 2**20)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    add_arguments(parser)
    args = parser.parse_args()
    validate_arguments(parser, args)
    run_experiments(args,
                    lambda port, pid, output: test(port, pid, args.seconds, args.requests_per_second,
                                                  output, **workload_options(args)),
                    lambda port: verify_requests(port, 'benchsustained', 1000,
                                                 int(args.seconds * args.requests_per_second) + 4))


if __name__ == '__main__':
    main()
