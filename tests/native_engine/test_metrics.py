import sys
import json
import hashlib
import unittest
from pathlib import Path

import numpy as np
import taichi as ti

ROOT = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(ROOT / "native-engine"), str(ROOT / "public" / "pykernel")]
from engine.runtime import initialize_runtime, plan_tile
from engine.vm_ti import StackVM
from engine.metrics_ti import TrainingMetrics, NumericalReports, METRIC_NAMES
from engine.selfcheck import run_startup_selfcheck, compare_bytes
from factor_lab.scoring.evaluate import evaluate_factor


class MetricsTests(unittest.TestCase):
    def test_desktop_zero_return_plateaus_preserve_downside_membership(self):
        fixture = json.loads((Path(__file__).parent / 'fixtures/training-zero-pyodide.json').read_text())
        self.assertEqual(fixture['wasm_sha256'], hashlib.sha256((ROOT / 'public/pyodide/pyodide.asm.wasm').read_bytes()).hexdigest())
        for name, digest in fixture['source_sha256'].items():
            self.assertEqual(digest, hashlib.sha256((ROOT / name).read_bytes()).hexdigest())
        for case in fixture['cases']:
            with self.subTest(case=case['case'], offset=case['offset']):
                arrays = {key: np.array([int(x) for x in case[key]], dtype=np.uint64).view(np.float64)
                          for key in ('factor', 'close', 'positions', 'pnl', 'turnovers')}
                factors = ti.ndarray(ti.f64, shape=(1, len(arrays['factor'])))
                factors.from_numpy(arrays['factor'][None, :])
                metrics = TrainingMetrics(arrays['close'], fixture['cost'], case['periods'], tile=1)
                first = metrics.evaluate(factors, 1)
                self.assertEqual(first.tobytes(), metrics.evaluate(factors, 1).tobytes())
                np.testing.assert_array_equal(metrics.positions.to_numpy()[0].view(np.uint64), arrays['positions'].view(np.uint64))
                # Endpoints use this local slice's initial position/terminal
                # return; interior cashflows retain the frozen desktop calendar.
                for key, buffer in (('pnl', metrics.pnls), ('turnovers', metrics.turnovers)):
                    actual = buffer.to_numpy()[0, 1:-1]
                    expected = arrays[key][1:-1]
                    np.testing.assert_array_equal(actual.view(np.uint64), expected.view(np.uint64), err_msg=key)
                    np.testing.assert_array_equal(actual < 0, expected < 0)
                reports = NumericalReports([{'close': float(x)} for x in arrays['close']], tile=1)
                reports._cashflows(factors, 1, 0, len(arrays['close']), fixture['cost'], 'close', .3, 1)
                np.testing.assert_array_equal(reports.positions.to_numpy()[0].view(np.uint64), arrays['positions'].view(np.uint64))
                np.testing.assert_array_equal(reports.flows.to_numpy()[0, 0, 1:-1].view(np.uint64), arrays['pnl'][1:-1].view(np.uint64))

    def test_new_sessions_reuse_startup_training_program_with_runtime_configuration(self):
        runtime = initialize_runtime("f64", require_cuda=True)
        close = 100 + np.sin(np.arange(1025) / 13)
        first = TrainingMetrics(close, .0003, 35040, tile=2)
        first_vm = StackVM(np.vstack((np.sin(np.arange(1025) / 9),)), "f64", tile=2)
        first_vm.dispatch([[0]])
        first.evaluate(first_vm.factors, 1)
        program = first.program
        names = ("_positions", "_pnl_cache", "_summary", "_means", "_centered", "_draw_blocks", "_merge_draw", "_finish")
        compiled = {name: len(getattr(program, name)._primal.compiled_kernels) for name in names}
        second_close = 150 + np.cos(np.arange(4097) / 21)
        second = TrainingMetrics(second_close, .0007, 8760, tile=1, head_trim=37)
        second_vm = StackVM(np.vstack((np.sin(np.arange(4097) / 8),)), "f64", tile=1)
        second_vm.dispatch([[0]])
        actual = second.evaluate(second_vm.factors, 1)
        self.assertIs(second.program, program)
        self.assertEqual(compiled, {name: len(getattr(program, name)._primal.compiled_kernels) for name in names})
        expected = evaluate_factor(second_vm.factors.to_numpy()[0, 37:], second_close[37:], .0007, 8760)
        for key in ("ann_ret", "sortino", "calmar", "ts_ic", "composite"):
            self.assertAlmostEqual(actual[0, METRIC_NAMES.index(key)], expected[key], delta=1e-9)

    @classmethod
    def setUpClass(cls):
        initialize_runtime("f64", require_cuda=True)

    def test_gpu_metrics_match_raw_cpu_metrics_and_repeat(self):
        for T in (21, 513, 1025):
            with self.subTest(T=T):
                x = np.arange(T, dtype=float)
                matrix = np.vstack((np.sin(x / 7), np.cos(x / 13)))
                close = 100 * np.exp(np.cumsum(.001 * np.sin(x / 9) + .00003))
                vm = StackVM(matrix, "f64", tile=2)
                factors = vm.execute_batch([[0], [1]])
                metrics = TrainingMetrics(close, .0003, 365 * 24, tile=2)
                native = metrics.evaluate(vm.factors, 2)
                repeat = metrics.evaluate(vm.factors, 2)
                self.assertEqual(native.tobytes(), repeat.tobytes())
                for p in range(2):
                    expected = evaluate_factor(factors[p], close, .0003, 365 * 24)
                    for k, name in enumerate(METRIC_NAMES):
                        if name in expected:
                            self.assertAlmostEqual(native[p, k], expected[name], delta=1e-10, msg=name)

    def test_startup_twenty_tokens_both_modes(self):
        for precision in ("mixed", "f64"):
            report = run_startup_selfcheck(precision)
            self.assertTrue(report["passed"])
            self.assertEqual(report["token_count"], 20)
            self.assertEqual(report["eval_precision"], "f64")
            self.assertEqual(report["coarse_passed"], True if precision == "mixed" else None)

    def test_cached_position_and_pnl_reset_at_head_trim(self):
        x = np.arange(513, dtype=float)
        matrix = np.vstack((np.sin(x / 7), np.cos(x / 13)))
        close = 100 * np.exp(np.cumsum(.001 * np.sin(x / 9) + .00003))
        vm = StackVM(matrix, "f64", tile=2)
        factors = vm.execute_batch([[0], [1]])
        head = 17
        metrics = TrainingMetrics(close, .0003, 365 * 24, tile=2, head_trim=head)
        native = metrics.evaluate(vm.factors, 2)
        for p in range(2):
            expected = evaluate_factor(factors[p, head:], close[head:], .0003, 365 * 24)
            for k, name in enumerate(METRIC_NAMES):
                if name in expected:
                    self.assertAlmostEqual(native[p, k], expected[name], delta=1e-10, msg=name)

    def test_bit_flip_rejects_selfcheck(self):
        first = np.array([1.0], dtype=np.float64)
        second = first.copy()
        second.view(np.uint64)[0] ^= np.uint64(1)
        self.assertFalse(compare_bytes(first, second))
        self.assertFalse(compare_bytes(np.array([np.nan]), np.array([np.nan])))

    def test_memory_plan_shrinks_and_respects_single_candidate_budget(self):
        self.assertLess(plan_tile(70_174, 62, 3000, "f64", 6140), 3000)
        with self.assertRaises(MemoryError):
            plan_tile(246_000, 62, 3000, "f64", 1)


if __name__ == "__main__":
    unittest.main()
