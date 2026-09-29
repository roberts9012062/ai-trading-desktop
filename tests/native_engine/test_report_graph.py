"""Sequential report submission must preserve direct-kernel report bytes."""
import sys
import unittest
from pathlib import Path

import numpy as np
import taichi as ti

ROOT = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(ROOT/'native-engine'), str(ROOT/'public/pykernel'), str(Path(__file__).parent)]


class ReportGraphTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from engine.runtime import initialize_runtime
        initialize_runtime('f64', require_cuda=True)

    def test_graph_preserves_all_continuous_modes_counts_slices_and_cashflows(self):
        from engine.metrics_ti import NumericalReports, REPORT_NAMES
        from test_reports import report_bars
        for size in (513, 2061):
            with self.subTest(size=size):
                bars = report_bars(size)
                x = np.arange(size)
                matrix = np.vstack((2*np.sin(x/13), 1.4*np.cos(x/19)))
                matrix[0, 27], matrix[1, 37] = -0., 0.
                factors = ti.ndarray(ti.f64, shape=matrix.shape)
                factors.from_numpy(matrix)
                direct = NumericalReports(bars, tile=2)
                direct.graph_dispatch = False
                graphed = direct.with_tile(3)
                graphed.graph_dispatch = True
                before = direct.source.to_numpy().tobytes()
                for count, lo, hi, cost in ((2, 17, size-3, .0003), (1, 0, size, .0006), (2, 31, size-41, 0.)):
                    expected = direct.evaluate_slice_modes(factors, count, lo, hi, cost, 35040)
                    flow_bytes = direct.flows.to_numpy()[:count].tobytes()
                    actual = graphed.evaluate_slice_modes(factors, count, lo, hi, cost, 35040)
                    self.assertIsNotNone(getattr(graphed, 'slice_graph', None))
                    numeric = lambda result: np.asarray([[[row[name] for name in REPORT_NAMES] for row in mode] for mode in result])
                    self.assertEqual(numeric(expected).tobytes(), numeric(actual).tobytes())
                    self.assertEqual(flow_bytes, graphed.flows.to_numpy()[:count].tobytes())
                    repeat = graphed.evaluate_slice_modes(factors, count, lo, hi, cost, 35040)
                    self.assertEqual(numeric(actual).tobytes(), numeric(repeat).tobytes())
                self.assertEqual(before, graphed.source.to_numpy().tobytes())
                with self.assertRaises(ValueError):
                    graphed.evaluate_slice_modes(factors, 2, 0, size, np.nan, 35040)
                with self.assertRaises(ValueError):
                    graphed.evaluate_slice_modes(factors, 4, 0, size, .0003, 35040)


if __name__ == '__main__':
    unittest.main()
