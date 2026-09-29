"""Shared sliding input caches preserve every original arithmetic operation."""
import sys
import unittest
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(ROOT/'native-engine'), str(ROOT/'public/pykernel')]
from engine.runtime import initialize_runtime
from engine.vm_ti import StackVM


class SharedWindowTests(unittest.TestCase):
    def test_all_rolling_reads_keep_bytes_across_halos_partial_blocks_and_prefixes(self):
        initialize_runtime('mixed', require_cuda=True)
        ops = [op for op in range(13, 51) if op not in (26, 29, 35, 36, 37, 38, 39, 44, 45)]
        candidates = [[0, 64+op] for op in ops]+[[0, 1, 64+op] for op in (29, 35, 36)]
        candidates += [[2, 81], [2, 0, 93]]
        for size in (255, 257, 513):
            t = np.arange(size)
            matrix = np.vstack((np.sin(t/17), np.cos(t/13)+.3, np.sin(t/19)*1e30))
            matrix[0, 129] = np.nan
            for compensated in (False, True):
                with self.subTest(size=size, compensated=compensated):
                    original = StackVM(matrix, 'mixed', tile=len(candidates),
                        compensated_rolling=compensated, shared_windows=False)
                    cached = StackVM(matrix, 'mixed', tile=len(candidates),
                        compensated_rolling=compensated, shared_windows=True)
                    expected = original.execute_batch(candidates, normalize=False)
                    actual = cached.execute_batch(candidates, normalize=False)
                    self.assertEqual(actual.tobytes(), expected.tobytes())
                    self.assertEqual(actual.tobytes(), cached.execute_batch(candidates, normalize=False).tobytes())
                    prefix = StackVM(matrix[:, :191], 'mixed', tile=len(candidates),
                        compensated_rolling=compensated, shared_windows=True)
                    self.assertEqual(prefix.execute_batch(candidates, normalize=False).tobytes(), actual[:, :191].tobytes())


if __name__ == '__main__':
    unittest.main()
