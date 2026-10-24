"""Server-free payload, accounting, and failure-cleanup checks; no performance assertions."""
import argparse
import json
import os
import pathlib
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import diagnostic
import mixed
import sustained
from run import identified


class HarnessTests(unittest.TestCase):
    def test_default_body_and_fresh_identities(self):
        payload = mixed.compact_payload()
        metadata = mixed.preflight(payload, 8204, 127, 120, 4)
        self.assertEqual(metadata['payload_bytes'], 9556551)
        self.assertLess(metadata['payload_bytes'], 10 * 2**20)
        self.assertEqual(metadata['fields_including_server_timestamp'], 128)
        rows = json.loads(identified(payload, 8))
        self.assertEqual([row['row_id'] for row in rows], list(range(8204)))
        self.assertTrue(all(row['request_id'] == '00000008' and len(row) == 127 for row in rows))
        self.assertNotEqual(identified(payload, 8), identified(payload, 9))

    def test_preflight_rejects_oversize_and_bad_rows(self):
        with self.assertRaisesRegex(ValueError, 'HTTP body'):
            mixed.preflight(b' ' * sustained.HTTP_LIMIT, 1, 3, 1, 1)
        with self.assertRaisesRegex(AssertionError, 'preflight'):
            mixed.preflight(mixed.compact_payload(2, 3), 3, 3, 1, 1)

    def test_wall_and_monotonic_observation(self):
        item = sustained.observation(7, 12., (12.25, 102.25), (13., 104.), (10., 100.))
        self.assertEqual(item['due_wall_s'], 102.)
        self.assertEqual(item['lag_s'], .25)
        self.assertEqual(item['latency_s'], .75)
        self.assertEqual(item['scheduled_latency_s'], 1.)
        self.assertEqual(item['end_wall_s'], 104.)  # Actual wall clock may jump.
        summary = sustained.latency_summary([item])
        self.assertEqual(summary['p99_9_ms'], 750.)
        self.assertEqual(summary['max_ms'], 750.)

    def test_legacy_defaults(self):
        parser = argparse.ArgumentParser()
        sustained.add_arguments(parser)
        args = parser.parse_args(['--baseline', '/bin/true', '--candidate', '/bin/true', '--output', '/tmp/unused'])
        sustained.validate_arguments(parser, args)
        self.assertEqual((args.pairs, args.seconds, args.requests_per_second, args.workers), (1, 300, 20, 4))
        self.assertFalse(args.diagnostics)

    def test_pair_order_names_and_restart_marker(self):
        for pairs in (1, 2):
            with tempfile.TemporaryDirectory() as directory:
                parser = argparse.ArgumentParser()
                sustained.add_arguments(parser)
                output = pathlib.Path(directory) / 'new-root'
                args = parser.parse_args(['--baseline', '/bin/true', '--candidate', '/bin/true',
                                          '--output', str(output), '--pairs', str(pairs)])
                calls = []
                def fake_arm(binary, root, arm, pair, cases, cpus, action, persisted_restart_check):
                    self.assertIsNotNone(persisted_restart_check)
                    calls.append((pair, arm))
                    result = action(1, 1)
                    result['persisted_only_restart_verified'] = True
                    return result
                def action(port, pid, target):
                    target.write_text(json.dumps(dict(observations=[], result={})))
                    return dict(samples=[])
                with patch.object(sustained, 'run_arm', side_effect=fake_arm), patch('builtins.print'):
                    sustained.run_experiments(args, action, lambda port: None)
                expected = [(0, 'baseline'), (0, 'candidate')]
                if pairs == 2:
                    expected += [(1, 'candidate'), (1, 'baseline')]
                self.assertEqual(calls, expected)
                for pair, arm in calls:
                    name = arm if pairs == 1 else f'pair{pair}-{arm}'
                    document = json.loads((output / (name + '-samples.json')).read_text())
                    self.assertTrue(document['result']['persisted_only_restart_verified'])

    def exercise(self, fail=None):
        seen = []
        lock = threading.Lock()
        def fake_request(port, method, path, body=None, stream=None, connection=None):
            if path.endswith('/query'):
                with lock:
                    n = len(seen)
                return json.dumps([{'n': n if fail != 'count' else -1}]).encode()
            row = json.loads(body)[0]
            with lock:
                seen.append(row['request_id'])
            if fail == 'ingest' and row['request_id'] == '00000004':
                raise RuntimeError('injected ingest failure')
            return b''
        with tempfile.TemporaryDirectory() as directory:
            output = pathlib.Path(directory) / 'samples.json'
            with patch.object(sustained, 'request', side_effect=fake_request), \
                 patch.object(sustained, 'verify_requests') as oracle, \
                 patch.object(sustained, 'drain', return_value=0):
                args = dict(payload=mixed.compact_payload(1, 3), rows=1, stream='unused',
                            workers=2, query_rate=100, phase_align=False)
                if fail:
                    with self.assertRaises((RuntimeError, AssertionError)):
                        sustained.exercise(1, os.getpid(), .02, 100, output, **args)
                else:
                    result = sustained.exercise(1, os.getpid(), .02, 100, output, **args)
                    self.assertEqual(result['accepted_requests'], 2)
                    self.assertEqual(result['query_requests'], 2)
                    self.assertEqual(result['verified_rows_before_and_after_drain'], 6)
                    self.assertEqual(oracle.call_count, 2)
                    self.assertEqual(sorted(seen), [f'{i:08d}' for i in range(6)])
                document = json.loads(output.read_text())
                for item in document['observations']:
                    self.assertLessEqual(item['start_monotonic_s'], item['end_monotonic_s'])
                if fail:
                    self.assertIn('error', document['result'])
                if fail == 'count':
                    self.assertEqual(document['result']['query_count_errors'], 1)
                if fail == 'ingest':
                    self.assertTrue(any(not item['accepted'] for item in document['observations']))
        self.assertFalse(any(t.name == 'resource-monitor' or t.name.startswith('ThreadPoolExecutor')
                             for t in threading.enumerate()))

    def test_acceptance_and_inflight_query_accounting(self):
        self.exercise()

    def test_concurrent_count_visibility_bounds(self):
        observations = [dict(start_monotonic_s=1., end_monotonic_s=2., accepted=True),
                        dict(start_monotonic_s=3., end_monotonic_s=5., accepted=True),
                        dict(start_monotonic_s=7., end_monotonic_s=8., accepted=True)]
        # At query start one timed request has ACKed; another is in flight.
        # The third request has not started even when this query finishes.
        for count, valid in [(0, False), (4, False), (5, True), (6, True), (7, False)]:
            with self.subTest(count=count):
                query = dict(request=0, start_monotonic_s=4., end_monotonic_s=6.,
                             count=count, error=None, error_kind=None)
                if valid:
                    sustained.validate_query_counts([query], observations, 1, 4)
                    self.assertIsNone(query['error'])
                else:
                    with self.assertRaisesRegex(AssertionError, 'visibility'):
                        sustained.validate_query_counts([query], observations, 1, 4)
                    self.assertEqual(query['error_kind'], 'count')
                self.assertEqual((query['min_visible_rows'], query['max_visible_rows']), (5, 6))

    def test_ingest_failure_propagates_and_cleans_threads(self):
        self.exercise('ingest')

    def test_query_count_failure_propagates_and_cleans_threads(self):
        self.exercise('count')

    def test_diagnostic_budget(self):
        with tempfile.TemporaryDirectory() as directory:
            sampler = diagnostic.Diagnostics(os.getpid(), pathlib.Path(directory) / 'threads.jsonl', max_bytes=1)
            sampler._run()
            self.assertTrue(sampler.stats['capped'])
            self.assertEqual(sampler.stats['bytes'], 0)
            self.assertFalse(sampler.errors)


if __name__ == '__main__':
    unittest.main(verbosity=2)
