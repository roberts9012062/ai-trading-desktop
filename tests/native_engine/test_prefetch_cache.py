"""Batch prefetch must respect the CPU cache's existing aliases and LRU order."""
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

ROOT = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(ROOT/'native-engine'), str(ROOT/'public/pykernel')]
from engine.wf_ti import _SEG_RESULTS
from engine.slice_batch_ti import BatchSlices


class PrefetchCacheTests(unittest.TestCase):
    def test_cached_aliases_skip_gpu_work_without_changing_lru_or_results(self):
        saved = list(_SEG_RESULTS.items())
        signature = (601, b'frozen-calendar')
        context = SimpleNamespace(bars=[{'_factor_market': 'crypto_ohlcv_v1'}]*601,
            timeframe='15m', signature=lambda start, hi: signature,
            _context=Mock(side_effect=AssertionError('GPU work for cached report')))
        first, second = {'sortino': 1.25}, {'sortino': -2.5}
        keys = [('slice', tokens, signature, '15m', .0003) for tokens in ((0,), (1,))]
        try:
            _SEG_RESULTS.clear()
            _SEG_RESULTS.update(zip(keys, (first, second)))
            before = list(_SEG_RESULTS.items())
            batch = BatchSlices(context)
            batch.prefetch([[1], [0], [0]], [(100, 601, .0003), (0, 601, .0003)])
            self.assertEqual(batch.results, {})
            self.assertEqual(list(_SEG_RESULTS.items()), before)
            self.assertIs(batch.peek([0], 100, 601, .0003), first)
            self.assertIs(batch.peek([0], 0, 601, .0003), first)
            self.assertIs(batch.peek([1], 100, 601, .0003), second)
            context._context.assert_not_called()
        finally:
            _SEG_RESULTS.clear()
            _SEG_RESULTS.update(saved)


if __name__ == '__main__':
    unittest.main()
