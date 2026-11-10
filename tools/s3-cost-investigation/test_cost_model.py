import unittest
from cost_model import UNITS, compare


class CostModelTests(unittest.TestCase):
    def test_separate_storage_request_transfer_compute_and_rewrite(self):
        rates = dict.fromkeys(UNITS, 0)
        rates.update(storage_gb_month=2, get_head_1000=3, paid_transfer_gb=5, compute_vcpu_hours=7)
        base = dict.fromkeys(UNITS, 0)
        base.update(storage_gb_month=100, get_head_1000=10, paid_transfer_gb=20, compute_vcpu_hours=10)
        new = dict(base, storage_gb_month=80, get_head_1000=12, paid_transfer_gb=15, compute_vcpu_hours=12)
        result = compare(dict(rates=rates, baseline=base, candidates=[dict(name="probe", quantities=new, one_time_cost=90)]))
        self.assertEqual(result["baseline_monthly_cost"], 400)
        candidate = result["candidates"][0]
        self.assertEqual(candidate["monthly_saving"], 45)
        self.assertEqual(candidate["first_month_saving"], -45)
        self.assertEqual(candidate["break_even_months"], 2)

    def test_missing_and_invalid_inputs_rejected(self):
        for bad in ({}, dict.fromkeys(UNITS, float("nan")), dict.fromkeys(UNITS, -1)):
            with self.assertRaises(ValueError):
                compare(dict(rates=bad, baseline=dict.fromkeys(UNITS, 0), candidates=[]))

    def test_ranking_and_no_break_even_for_regression(self):
        zero = dict.fromkeys(UNITS, 0)
        document = dict(rates=dict.fromkeys(UNITS, 1), baseline=dict(zero, storage_gb_month=10),
                        candidates=[dict(name="regression", quantities=dict(zero, storage_gb_month=20)),
                                    dict(name="saving", quantities=dict(zero, storage_gb_month=5))])
        results = compare(document)["candidates"]
        self.assertEqual([x["name"] for x in results], ["saving", "regression"])
        self.assertIsNone(results[1]["break_even_months"])


if __name__ == "__main__":
    unittest.main()
