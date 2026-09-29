"""Design-permitted f32 two-sum coarse normalization; authority remains f64."""
import sys
import unittest
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(ROOT/'native-engine'), str(ROOT/'public/pykernel')]
from engine.runtime import initialize_runtime
from engine.vm_ti import StackVM


class CompensatedCoarseTests(unittest.TestCase):
    def test_compensation_accuracy_determinism_prefix_and_large_value_fallback(self):
        initialize_runtime('mixed', require_cuda=True)
        t = np.arange(1025)
        rows = np.vstack((np.sin(t/17), np.full(1025, 1.4), np.sin(t/13)*1e30))
        tokens = [[0], [1], [2]]
        for normalization, window in (('legacy', 7), ('causal_v2', 250)):
            original = StackVM(rows, 'mixed', tile=3, norm_window=window,
                normalization=normalization, compensated_coarse=False)
            compensated = StackVM(rows, 'mixed', tile=3, norm_window=window,
                normalization=normalization, compensated_coarse=True)
            self.assertEqual(original.execute_batch(tokens, normalize=False).tobytes(),
                             compensated.execute_batch(tokens, normalize=False).tobytes())
            expected = original.execute_batch(tokens)
            actual = compensated.execute_batch(tokens)
            self.assertEqual(actual.tobytes(), compensated.execute_batch(tokens).tobytes())
            np.testing.assert_allclose(actual[:2], expected[:2], rtol=1e-6, atol=1e-6)
            # Overflow of the f32 expansion uses the retained f64 window path.
            self.assertEqual(actual[2].tobytes(), expected[2].tobytes())
            if normalization == 'causal_v2':
                prefix = StackVM(rows[:, :601], 'mixed', tile=3, norm_window=window,
                    normalization=normalization, compensated_coarse=True).execute_batch(tokens)
                self.assertEqual(prefix.tobytes(), actual[:, :601].tobytes())


if __name__ == '__main__':
    unittest.main()
