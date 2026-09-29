"""Shared GPU prefixes must neither read suffix data nor change authority."""
import sys
import unittest
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(ROOT/'native-engine'), str(ROOT/'public/pykernel')]
from engine.runtime import initialize_runtime
from engine.features_ti import GpuFeatureMatrix
from engine.series_ti import GpuSeries
from engine.vm_ti import StackVM


class FeatureViewTests(unittest.TestCase):
    def test_shared_prefix_retains_logical_availability_and_exact_vm_calendar(self):
        initialize_runtime('f64', require_cuda=True)
        t = np.arange(1025)
        host = np.vstack((np.sin(t/17), np.cos(t/13)))
        host[:, 601:] = 1e30
        host[1, 800:] = np.nan
        root = GpuFeatureMatrix([GpuSeries.upload(row) for row in host])
        view, copied = root.frozen_prefix(601), root.prefix(601)
        self.assertIs(view.matrix, root.matrix)
        self.assertEqual(view.visible_length, 601)
        self.assertEqual(view.to_numpy().tobytes(), copied.to_numpy().tobytes())
        self.assertEqual(view.availability(), copied.availability())
        candidates = [[0], [0, 77], [0, 1, 93]]
        for precision in ('f64', 'mixed'):
            actual = StackVM(view.matrix, precision, tile=3, bar_count=view.visible_length)
            expected = StackVM(copied.matrix, precision, tile=3)
            self.assertEqual(actual.T, 601)
            self.assertEqual(actual.execute_batch(candidates).tobytes(), expected.execute_batch(candidates).tobytes())
        self.assertEqual(view.frozen_prefix(257).to_numpy().tobytes(), host[:, :257].tobytes())
        for bad in (602, 0, True):
            with self.assertRaises(ValueError):
                view.frozen_prefix(bad)
        with self.assertRaises(ValueError):
            view.availability(602)


if __name__ == '__main__':
    unittest.main()
