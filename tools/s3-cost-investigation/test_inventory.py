import unittest
from inventory import summarize


class InventoryTests(unittest.TestCase):
    def test_boundaries_and_minimum_storage_control(self):
        result = summarize([dict(size=0, kind="metadata"), dict(size=131071), dict(size=131072), dict(size=1048576), dict(size=26214400)])
        self.assertEqual(result["bins"], dict(lt128KiB=2, **{"128KiB_to_1MiB": 1, "1_to_25MiB": 1, "ge25MiB": 1}))
        self.assertEqual(result["hypothetical_128KiB_minimum_billable_bytes"] - result["bytes"], 131073)
        self.assertEqual(result["kinds"]["metadata"], dict(count=1, bytes=0))
        self.assertEqual(summarize([])["quantile_bytes"]["0.5"], None)

    def test_invalid_size(self):
        for value in (-1, 1.5, True):
            with self.assertRaises(ValueError):
                summarize([dict(size=value)])


if __name__ == "__main__":
    unittest.main()
