"""Real CUDA VM checks, never silently skip on unavailable CUDA."""
import sys
import unittest
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(ROOT / "native-engine"), str(ROOT / "public" / "pykernel")]
from engine.runtime import initialize_runtime
from engine.vm_ti import StackVM
from factor_lab.ops import OPS_CONFIG
from factor_lab.vm import execute


class VMTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.runtime = initialize_runtime("f64", require_cuda=True)
        x = np.arange(513, dtype=float)
        cls.matrix = np.vstack([np.sin(x / 9), np.cos(x / 17) + .2, x / 513])
        cls.vm = StackVM(cls.matrix, precision="f64", tile=8)

    def test_all_supported_operator_semantics(self):
        for op, (_, fn, arity) in enumerate(OPS_CONFIG):
            if op in (38, 39, 44, 45):
                continue
            tokens = [0, 1, 64 + op] if arity == 2 else [0, 64 + op]
            with self.subTest(op=op):
                actual = self.vm.execute_batch([tokens], normalize=False)[0]
                expected = fn(*[self.matrix[i] for i in range(arity)])
                expected = np.nan_to_num(expected, nan=0, posinf=1, neginf=-1)
                np.testing.assert_allclose(actual, expected, rtol=2e-9, atol=2e-9)

    def test_causal_normalization_and_repeat_bytes(self):
        tokens = [[0], [0, 1, 64], [0, 77, 1, 93]]
        first = self.vm.execute_batch(tokens)
        second = self.vm.execute_batch(tokens)
        self.assertEqual(first.tobytes(), second.tobytes())
        for i, candidate in enumerate(tokens):
            np.testing.assert_allclose(first[i], execute(candidate, self.matrix, normalization="causal_v2"), atol=2e-8, rtol=2e-8)

    def test_invalid_and_unsupported_candidates_are_not_scored(self):
        for tokens in ([], [3], [64], [0, 1], [0, 102], [0] * 9, [0] * 33):
            with self.subTest(tokens=tokens):
                with self.assertRaises(ValueError):
                    self.vm.execute_batch([tokens])

    def test_mixed_elementwise_division_uses_f32(self):
        vm = StackVM(self.matrix, precision="mixed", tile=1)
        x, y = self.matrix[:2].astype(np.float32)
        expected = x / np.maximum(np.abs(y), np.float32(1e-8)) * np.sign(y + np.float32(1e-12))
        actual = vm.execute_batch([[0, 1, 67]], normalize=False)[0].astype(np.float32)
        self.assertEqual(vm.stack.dtype, __import__('taichi').f32)
        # CUDA f32 division may differ from numpy by an ULP. Determinism is
        # checked against another native run; full CPU G2 keeps its 1e-9 gate.
        np.testing.assert_allclose(actual, expected, rtol=2e-7, atol=2e-7)
        repeat = vm.execute_batch([[0, 1, 67]], normalize=False)[0].astype(np.float32)
        self.assertEqual(actual.tobytes(), repeat.tobytes())

    def test_fixed_windows_preserve_prefix_in_both_precisions(self):
        tokens = [[0, 79], [0, 1, 93], [0, 113], [0, 106]]
        for precision in ("mixed", "f64"):
            whole = StackVM(self.matrix, precision, tile=4).execute_batch(tokens)
            prefix = StackVM(self.matrix[:, :300], precision, tile=4).execute_batch(tokens)
            self.assertEqual(whole[:, :300].tobytes(), prefix.tobytes())

    def test_legacy_new_tokens_keep_cpu_causal_near_constant_policy(self):
        x = np.arange(513, dtype=float) * 1e-10
        matrix = np.tile(x, (41, 1))
        tokens = [[0], [40]]
        actual = StackVM(matrix, "f64", tile=2, normalization="legacy").execute_batch(tokens)
        for i, candidate in enumerate(tokens):
            expected = execute(candidate, matrix, normalization="legacy")
            np.testing.assert_allclose(actual[i], expected, rtol=1e-8, atol=1e-8)

    def test_authoritative_rolling_matches_cpu_long_prefix_cancellation(self):
        x = np.arange(4097, dtype=float)
        matrix = np.vstack((np.sin(x / 9), np.cos(x / 17)))
        tokens = [[0, 80, 72, 83, 110], [0, 95, 110, 76, 112]]
        actual = StackVM(matrix, "f64", tile=2, normalization="legacy").execute_batch(tokens)
        for i, candidate in enumerate(tokens):
            expected = execute(candidate, matrix, normalization="legacy")
            np.testing.assert_allclose(actual[i], expected, rtol=1e-9, atol=1e-9)

    def test_authoritative_prefix_rounding_at_chunk_and_tail_boundaries(self):
        x = np.arange(4097, dtype=float)
        matrix = np.vstack((1e8 + np.sin(x / 9), np.cos(x / 17)))
        candidates = [[0, 77], [0, 95], [1, 80], [1, 95]]
        actual = StackVM(matrix, "f64", tile=4).execute_batch(candidates, normalize=False)
        for p, candidate in enumerate(candidates):
            expected = OPS_CONFIG[candidate[-1] - 64][1](matrix[candidate[0]])
            self.assertEqual(actual[p].tobytes(), expected.tobytes())

    def test_authoritative_division_and_residual_rounding_boundaries(self):
        x = np.arange(513, dtype=float)
        a = 1e5 + np.sin(x / 9)
        b = 1e-7 + np.abs(np.cos(x / 17))
        matrix = np.vstack((a, b, a.copy()))
        vm = StackVM(matrix, "f64", tile=2)
        candidates = [[0, 1, 67], [0, 2, 100]]
        actual = vm.execute_batch(candidates, normalize=False)
        for i, candidate in enumerate(candidates):
            op = OPS_CONFIG[candidate[-1] - 64][1]
            expected = op(matrix[candidate[0]], matrix[candidate[1]])
            self.assertEqual(actual[i].tobytes(), expected.tobytes())

    def test_startup_program_is_reused_for_new_bar_counts_and_configuration(self):
        self.vm.execute_batch([[0]])
        program = self.vm.program
        compiled = len(program._execute._primal.compiled_kernels)
        x = np.arange(4097, dtype=float)
        matrix = np.vstack((np.sin(x / 9), np.cos(x / 17)))
        other = StackVM(matrix, "f64", tile=2, norm_window=17, normalization="legacy")
        self.assertIs(other.program, program)
        actual = other.execute_batch([[0]])[0]
        np.testing.assert_allclose(actual, execute([0], matrix, norm_window=17), rtol=1e-9, atol=1e-9)
        self.assertEqual(len(program._execute._primal.compiled_kernels), compiled)


if __name__ == "__main__":
    unittest.main()
