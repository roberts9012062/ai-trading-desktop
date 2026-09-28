import sys
import unittest
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(ROOT / "native-engine"), str(ROOT / "public" / "pykernel")]
from engine.runtime import initialize_runtime, plan_tile
from engine.vm_ti import StackVM
from engine.metrics_ti import TrainingMetrics, METRIC_NAMES
from engine.selfcheck import run_startup_selfcheck, compare_bytes
from factor_lab.scoring.evaluate import evaluate_factor


class MetricsTests(unittest.TestCase):
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
