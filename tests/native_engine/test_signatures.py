"""Frozen prefix identities must retain the CPU cache's exact metadata format."""
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(ROOT / 'native-engine'), str(ROOT / 'public/pykernel')]
from factor_lab.features import bars_signature
from engine.signatures import freeze_prefix_signatures, report_prefix_ends


class SignatureTests(unittest.TestCase):
    def bars(self, count):
        return [{'time': f'2025-01-{i+1:03d}', 'open': 100.0+i, 'close': 100.0-i/7,
                 'volume': -0.0 if i % 3 == 0 else 1000.0+i,
                 '_factor_market': 'crypto_local_v2', 'funding_rate': None if i % 2 else .0001,
                 'trade_count': i, 'quote_volume': 1e30 if i % 5 == 0 else None}
                for i in range(count)]

    def test_all_prefixes_match_unchanged_cpu_metadata_digest(self):
        bars = self.bars(101)
        ends = [101, 10, 55, 1, 20, 0, 55]
        actual = freeze_prefix_signatures(bars, ends)
        self.assertEqual(actual, {(0, end): bars_signature(bars[:end]) for end in set(ends)})
        self.assertEqual(freeze_prefix_signatures([], [0]), {(0, 0): (0,)})
        self.assertEqual(freeze_prefix_signatures(bars, []), {})

    def test_prefixes_encode_each_frozen_row_only_once(self):
        class CountingBar(dict):
            reads = 0

            def get(self, key, default=None):
                type(self).reads += 1
                return super().get(key, default)

        original = self.bars(101)
        bars = [CountingBar(bar) for bar in original]
        ends = [10, 20, 40, 60, 84]
        actual = freeze_prefix_signatures(bars, ends)
        self.assertEqual(actual, {(0, end): bars_signature(original[:end]) for end in ends})
        from engine.signatures import KEYS
        self.assertEqual(CountingBar.reads, len(KEYS) * max(ends))

    def test_invalid_prefixes_are_rejected(self):
        for ends in ([-1], [102], [1.5], [True]):
            with self.subTest(ends=ends), self.assertRaises(ValueError):
                freeze_prefix_signatures(self.bars(101), ends)

    def test_report_calendar_covers_only_known_prefix_metadata(self):
        metadata = {'all_bars': [None]*2000, 'train_bars': [None]*1400,
                    'test_bars': [None]*600, 'walk_forward_folds': 3, 'plan': None}
        self.assertEqual(report_prefix_ends(metadata, 2500),
                         {0, 500, 1000, 1400, 1500, 1550, 1700, 1850, 2000, 2500})
        metadata['walk_forward_folds'] = 100
        self.assertEqual(report_prefix_ends(metadata, 2500),
                         {0, 1400, 1550, 1700, 1850, 2000, 2500})
        metadata['plan'] = object()
        metadata['walk_forward_folds'] = 3
        self.assertEqual(report_prefix_ends(metadata, 2500),
                         {0, 1400, 1550, 1700, 1850, 2000, 2500})


if __name__ == '__main__':
    unittest.main()
