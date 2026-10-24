"""Server-free replay of real baseline responses and equal-failure counterexamples."""
import copy
import json
import pathlib
import unittest
from unittest import mock

import compatibility


class CompatibilityOracleTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # Captured at baseline 6aaee1d61c261c6b71c0dad30b6bee75ac654cab.
        cls.recorded = json.loads(pathlib.Path(__file__).with_name('compatibility-baseline.json').read_text())

    def replay(self, records):
        transcript = []
        for item in records:
            if 'creation' in item:
                transcript.append(item['creation'])
            transcript.extend(item.get('responses', []))
            if 'response' in item:
                transcript.append(item['response'])
            if 'schema' in item:
                transcript.append(item['schema'])
                status, stats = item['ingestion']
                transcript.append([status, {'ingestion': stats}])
                transcript.append(item['rows'])
        with mock.patch.object(compatibility, 'raw', side_effect=transcript) as raw:
            result = compatibility.run(0, 0)
            self.assertEqual(raw.call_count, len(transcript))
            return result

    def test_recorded_successful_transcript(self):
        self.assertEqual(self.replay(self.recorded), self.recorded)

    def test_equal_503_on_any_ingest_is_rejected(self):
        for case, item in enumerate(self.recorded):
            key = 'response' if 'response' in item else 'responses'
            responses = [item[key]] if key == 'response' else item[key]
            for index in range(len(responses)):
                with self.subTest(case=item['name'], request=index):
                    altered = copy.deepcopy(self.recorded)
                    failure = [503, {'error': 'unavailable'}]
                    if key == 'response':
                        altered[case][key] = failure
                    else:
                        altered[case][key][index] = failure
                    # Each arm must fail independently, before any equality check.
                    for _ in range(2):
                        with self.assertRaises(AssertionError):
                            self.replay(altered)

    def test_equal_readback_failures_are_rejected(self):
        for case, item in enumerate(self.recorded):
            for key in ('schema', 'ingestion', 'rows'):
                if key not in item:
                    continue
                with self.subTest(case=item['name'], inspection=key):
                    altered = copy.deepcopy(self.recorded)
                    altered[case][key] = [503, {'error': 'unavailable'}]
                    with self.assertRaises(AssertionError):
                        self.replay(altered)

    def test_static_success_status_does_not_hide_wrong_content(self):
        case = next(i for i, x in enumerate(self.recorded) if x['name'] == 'static')
        mutations = [
            lambda x: x['rows'].__setitem__(1, []),
            lambda x: x['rows'].__setitem__(1, x['rows'][1][:1]),
            lambda x: x['rows'][1][1].__setitem__('id', 1),
            lambda x: x['rows'][1][1].__setitem__('id', 3),
            lambda x: x['rows'][1][1].__setitem__('id', 2.0),
            lambda x: x['rows'][1][1].__setitem__('v', '3.5'),
            lambda x: x['rows'][1][1].__setitem__('ok', False),
            lambda x: x['schema'][1]['fields'][0].__setitem__('data_type', 'Utf8'),
            lambda x: x['ingestion'][1].__setitem__('count', 3),
            lambda x: x['ingestion'][1].__setitem__('lifetime_count', 3),
            lambda x: x['responses'][2].__setitem__(0, 200),
        ]
        for index, mutate in enumerate(mutations):
            with self.subTest(mutation=index):
                altered = copy.deepcopy(self.recorded)
                mutate(altered[case])
                with self.assertRaises(AssertionError):
                    self.replay(altered)


if __name__ == '__main__':
    unittest.main()
