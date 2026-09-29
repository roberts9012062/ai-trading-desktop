"""Private f32 rolling compensation never replaces the authoritative VM."""
import sys
import unittest
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(ROOT/'native-engine'), str(ROOT/'public/pykernel')]
from engine.runtime import initialize_runtime
from engine.vm_ti import StackVM


class CompensatedRollingTests(unittest.TestCase):
    def test_windows_approximate_retained_path_repeat_and_preserve_frozen_prefix(self):
        initialize_runtime('mixed', require_cuda=True)
        t = np.arange(513)
        matrix = np.vstack((np.sin(t/17), np.cos(t/13)+.3,
                            np.full(513, 1.4), np.sin(t/19)*1e30))
        unary = (13, 14, 15, 16, 17, 23, 30, 31, 32, 34, 46, 47, 48, 49)
        candidates = [[0, 64+op] for op in unary]+[[0, 1, 64+op] for op in (29, 35, 36)]
        candidates += [[2, 81], [2, 0, 93], [3, 81], [3, 0, 99]]
        legacy = StackVM(matrix, 'mixed', tile=len(candidates), compensated_rolling=False)
        compensated = StackVM(matrix, 'mixed', tile=len(candidates), compensated_rolling=True)
        expected = legacy.execute_batch(candidates, normalize=False)
        actual = compensated.execute_batch(candidates, normalize=False)
        np.testing.assert_allclose(actual, expected, rtol=2e-5, atol=2e-6)
        self.assertEqual(actual.tobytes(), compensated.execute_batch(candidates, normalize=False).tobytes())
        prefix = StackVM(matrix[:, :301], 'mixed', tile=len(candidates), compensated_rolling=True)
        self.assertEqual(prefix.execute_batch(candidates, normalize=False).tobytes(), actual[:, :301].tobytes())
        # Extreme magnitudes use the original fixed f64 intermediate path.
        self.assertEqual(actual[-2:].tobytes(), expected[-2:].tobytes())
        authority = StackVM(matrix[:2], 'f64', tile=3, compensated_rolling=False)
        strict_tokens = [[0, 81], [0, 1, 93], [0, 1, 100]]
        strict_expected = authority.execute_batch(strict_tokens)
        strict = StackVM(matrix[:2], 'f64', tile=3, compensated_rolling=True)
        self.assertEqual(strict_expected.tobytes(), strict.execute_batch(strict_tokens).tobytes())


if __name__ == '__main__':
    unittest.main()
