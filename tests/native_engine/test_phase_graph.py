"""Native graph submission must execute exactly the existing phase kernels."""
import sys
import unittest
from pathlib import Path
import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(ROOT/'native-engine'), str(ROOT/'public/pykernel')]


class PhaseGraphTests(unittest.TestCase):
    def test_graph_matches_direct_submission_for_ops_tails_counts_and_profiles(self):
        from engine.runtime import initialize_runtime
        from engine.vm_ti import BINARY, UNSUPPORTED, StackVM
        initialize_runtime('mixed', require_cuda=True)
        x = np.arange(513, dtype=float)
        matrix = np.vstack((np.sin(x/9), np.cos(x/17)+.2, np.sin(x/19)*1e30))
        matrix[0, 0] = np.nan
        candidates = [[0, 1, 64+op] if op in BINARY else [0, 64+op]
            for op in range(51) if op not in UNSUPPORTED]
        candidates += [[2, 81], [0, 95, 110, 76, 112], [1], [1, 1, 65]]
        for precision in ('mixed', 'f64'):
            for normalization in ('legacy', 'causal_v2'):
                for compensated in (False, True):
                    with self.subTest(precision=precision, normalization=normalization, compensated=compensated):
                        settings = dict(tile=64, norm_window=19, normalization=normalization,
                            execution_layout='candidate_time_block', compensated_coarse=compensated)
                        direct = StackVM(matrix, precision, graph_dispatch=False, **settings)
                        graph = StackVM(matrix, precision, graph_dispatch=True, **settings)
                        for tokens in (candidates, candidates[-3:]):
                            for normalize in (False, True):
                                expected = direct.execute_batch(tokens, normalize=normalize)
                                actual = graph.execute_batch(tokens, normalize=normalize)
                                self.assertEqual(actual.tobytes(), expected.tobytes())
                                self.assertEqual(actual.tobytes(), graph.execute_batch(tokens, normalize=normalize).tobytes())
                        prefix = StackVM(matrix, precision, graph_dispatch=True,
                            bar_count=257, **settings)
                        expected = direct.execute_batch(candidates, normalize=False)[:, :257]
                        self.assertEqual(prefix.execute_batch(candidates, normalize=False).tobytes(), expected.tobytes())


if __name__ == '__main__':
    unittest.main()
