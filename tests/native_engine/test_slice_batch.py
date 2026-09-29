"""Batch report numerics and the frozen CPU cache's observable read order."""
import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(ROOT/'native-engine'), str(ROOT/'public/pykernel')]


class SliceBatchTests(unittest.TestCase):
    def test_prefetch_matches_scalar_bytes_without_changing_cache_order(self):
        from engine.runtime import initialize_runtime
        from engine.features_ti import compute_features
        from engine.wf_ti import GpuResearchContext, evaluate_on_slice, _SEG_RESULTS
        from engine.slice_batch_ti import BatchSlices
        initialize_runtime('f64', require_cuda=True)
        start = datetime(2025, 1, 1, tzinfo=timezone.utc)
        bars = [{'time': (start+timedelta(minutes=15*i)).isoformat(), '_factor_market': 'crypto_ohlcv_v1',
                 'open': 100+np.sin(i/13), 'close': 100+np.sin(i/13), 'high': 102+np.sin(i/13),
                 'low': 98+np.sin(i/13), 'volume': 1000+i%19} for i in range(601)]
        context = GpuResearchContext(bars, '15m', .0003, resident=compute_features(bars))
        tokens = [[0], [1], [0, 1, 64], [0], [0, 102]]
        # The same full-context key is first read with lo=100, then lo=0.
        # Prefetching must not write the global cache in a different order.
        requests = [(100, 601, .0003), (0, 401, .0006), (0, 601, .0003)]
        _SEG_RESULTS.clear()
        expected = [evaluate_on_slice(context, t, lo, hi, cost)
                    for t in tokens for lo, hi, cost in requests]
        _SEG_RESULTS.clear()
        batch = BatchSlices(context, tile=2)
        batch.prefetch(tokens, list(reversed(requests)))
        self.assertEqual(len(_SEG_RESULTS), 0)
        context.prefetched_slices = batch.results
        try:
            actual = [evaluate_on_slice(context, t, lo, hi, cost)
                      for t in tokens for lo, hi, cost in requests]
            self.assertEqual(actual, expected)
            # Compare the actual non-aliased batch outputs before cache reads.
            for t in tokens:
                for lo, hi, cost in requests:
                    _SEG_RESULTS.clear()
                    frozen = context.prefetched_slices
                    context.prefetched_slices = {}
                    scalar = evaluate_on_slice(context, t, lo, hi, cost)
                    context.prefetched_slices = frozen
                    key = batch.key(t, lo, hi, cost)
                    self.assertEqual(frozen[key], scalar)
        finally:
            context.prefetched_slices = {}
            batch.dispose()
            context.dispose()
            _SEG_RESULTS.clear()


if __name__ == '__main__':
    unittest.main()
