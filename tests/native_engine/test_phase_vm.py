"""Approved instruction grid must preserve the original VM's factor bytes."""
import sys
import unittest
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(ROOT/'native-engine'), str(ROOT/'public/pykernel')]


class PhaseDecodeTests(unittest.TestCase):
    def test_rows_contain_only_control_metadata_and_fixed_stack_indices(self):
        from engine.phase_vm_ti import decode_instruction_rows
        rows = decode_instruction_rows([[0, 1, 93, 76], [2, 77]], 3)
        self.assertEqual(rows.dtype, np.int32)
        self.assertEqual(rows.shape, (2, 32, 6))
        # token, source_a, source_b, destination, rolling, active
        self.assertEqual(rows[0, :4].tolist(), [[0, 0, 0, 0, 0, 1],
            [1, 1, 1, 1, 0, 1], [93, 0, 1, 8, 1, 1], [76, 0, 0, 0, 0, 1]])
        self.assertFalse(rows[:, 4:, 5].any())
        self.assertEqual(rows[1, 1].tolist(), [77, 0, 0, 8, 1, 1])
        self.assertEqual(decode_instruction_rows([], 3).shape, (0, 32, 6))

    def test_decoder_retains_original_admission_errors(self):
        # m3.3: EMA(102)已支持,不再在准入层拒绝;仅结构性非法仍拒绝
        from engine.phase_vm_ti import decode_instruction_rows
        for tokens in ([], [3], [64], [0, 1], [0]*9, [0]*33):
            with self.subTest(tokens=tokens), self.assertRaises(ValueError):
                decode_instruction_rows([tokens], 3)


class PhaseVMTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from engine.runtime import initialize_runtime
        initialize_runtime('f64', require_cuda=True)

    def matrix(self, size):
        x = np.arange(size, dtype=float)
        matrix = np.vstack([np.sin(x/(9+i))+.2 for i in range(41)])
        matrix[1] = np.cos(x/17)+.3
        matrix[2] = 3.
        matrix[3] = np.sin(x/19)*1e30
        matrix[4, 0] = np.nan
        matrix[5] = 1e8+np.sin(x/9)
        return matrix

    def compare(self, matrix, candidates, precision, *, normalize, normalization='causal_v2', **options):
        from engine.vm_ti import StackVM
        original = StackVM(matrix, precision, tile=len(candidates),
            normalization=normalization, execution_layout='candidate_block', **options)
        phased = StackVM(matrix, precision, tile=len(candidates),
            normalization=normalization, execution_layout='candidate_time_block', **options)
        expected = original.execute_batch(candidates, normalize=normalize)
        actual = phased.execute_batch(candidates, normalize=normalize)
        self.assertEqual(actual.tobytes(), expected.tobytes(),
            f'{precision}/{normalization}/{normalize}')
        self.assertEqual(actual.tobytes(), phased.execute_batch(candidates, normalize=normalize).tobytes())
        return actual

    def test_all_operators_compound_stacks_and_partial_blocks_match_bytes(self):
        from engine.vm_ti import BINARY, UNSUPPORTED
        candidates = [[0, 1, 64+op] if op in BINARY else [0, 64+op]
            for op in range(51) if op not in UNSUPPORTED]
        candidates += [[3, 81], [4, 84], [4, 1, 68], [5, 77],
            [0, 80, 72, 83, 110], [0, 95, 110, 76, 112],
            [0]*8+[64]*7, [0], [40], [2], [0, 0, 65]]
        for size in (257, 513):
            for precision in ('mixed', 'f64'):
                with self.subTest(size=size, precision=precision):
                    self.compare(self.matrix(size), candidates, precision, normalize=False)

    def test_both_normalizations_prefix_isolation_and_constant_policy(self):
        from engine.vm_ti import StackVM
        candidates = [[0], [2], [0, 0, 65], [40], [4], [0, 79], [0, 1, 93], [0, 113]]
        matrix = self.matrix(513)
        for precision in ('mixed', 'f64'):
            for normalization in ('legacy', 'causal_v2'):
                with self.subTest(precision=precision, normalization=normalization):
                    actual = self.compare(matrix, candidates, precision,
                        normalize=True, normalization=normalization)
                    prefix = StackVM(matrix, precision, tile=len(candidates),
                        normalization=normalization, bar_count=257,
                        execution_layout='candidate_time_block').execute_batch(candidates)
                    # Legacy whole-series constant classification is the same
                    # here; each causal output uses only its sealed prefix.
                    self.assertEqual(prefix.tobytes(), actual[:, :257].tobytes())

    def test_retained_uncompensated_coarse_oracle(self):
        candidates = [[0, 1, 93], [0, 81], [0, 98], [0, 113], [3, 81]]
        self.compare(self.matrix(513), candidates, 'mixed', normalize=True,
            compensated_coarse=False, compensated_rolling=False, shared_windows=False)

    def test_long_authority_prefixes_and_nonfinite_cleanup_keep_bytes(self):
        candidates = [[5, 77], [5, 95], [0, 80], [0, 95], [0, 1, 100],
            [0, 95, 110, 76, 112]]
        self.compare(self.matrix(4097), candidates, 'f64', normalize=False)
        self.compare(self.matrix(4097), candidates, 'f64', normalize=True)
        matrix = np.array([[np.nan, np.inf, -np.inf, -0., 0., 1., -1.],
                           [1., 1., 1., -0., 1., -1., 1.]])
        candidates = [[0, 1, 64], [0, 1, 68], [0, 75], [0, 76], [0, 84], [0, 85]]
        for precision in ('mixed', 'f64'):
            self.compare(matrix, candidates, precision, normalize=False)


if __name__ == '__main__':
    unittest.main()
