"""Coarse mean-only windows retain fixed f64 additions and f32 results."""
import sys
import unittest
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(ROOT/'native-engine'), str(ROOT/'public/pykernel')]
from engine.runtime import initialize_runtime
from engine.vm_ti import StackVM


class CoarseMeanTests(unittest.TestCase):
    def test_mean_and_demean_keep_ascending_window_bytes_and_nonfinite_policy(self):
        initialize_runtime('mixed', require_cuda=True)
        t = np.arange(257)
        values = np.sin(t/17).astype(np.float32)
        values[21:24] = [1e30, -1e30, 3]
        values[151] = np.inf
        values[222] = np.nan
        vm = StackVM(values[None, :].astype(np.float64), 'mixed', tile=5, compensated_rolling=False)
        candidates = [[0, 64+op] for op in (13, 14, 15, 30, 34)]
        actual = vm.execute_batch(candidates, normalize=False)
        expected = np.zeros_like(actual, dtype=np.float32)
        with np.errstate(invalid='ignore', over='ignore'):
            for row, (op, window) in enumerate(((13, 5), (14, 10), (15, 20), (30, 60), (34, 20))):
                for index in range(len(values)):
                    total, square = 0., 0.
                    lo = max(0, index-window+1)
                    for value in values[lo:index+1]:
                        z = float(value)
                        total += z
                        square += z*z
                    mean = total/(index-lo+1)
                    variance = square/(index-lo+1)-mean*mean
                    value = float(values[index])-mean if op==34 else mean
                    if np.isnan(total) or np.isnan(square) or np.isnan(variance):
                        value = 0.
                    expected[row, index] = value
        self.assertEqual(actual.astype(np.float32).tobytes(), expected.tobytes())
        self.assertEqual(actual.tobytes(), vm.execute_batch(candidates, normalize=False).tobytes())


if __name__ == '__main__':
    unittest.main()
