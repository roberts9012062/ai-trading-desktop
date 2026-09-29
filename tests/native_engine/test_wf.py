"""Frozen GPU warmup/slice and fold contracts against the CPU oracle."""
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(ROOT / "native-engine"), str(ROOT / "public/pykernel")]
from engine.runtime import initialize_runtime
from factor_lab.market import prepare_bars
from factor_lab.scoring.walk_forward import evaluate_on_slice as cpu_slice, walk_forward_eval as cpu_wf, walk_forward_eval_v2 as cpu_wf_v2
from factor_lab.scoring.split_plan import build_split_plan
from test_features import feature_bars


class WalkForwardTests(unittest.TestCase):
    def test_crypto_recompute_prefix_reuses_frozen_resident_features(self):
        from unittest.mock import patch
        from engine.features_ti import compute_features
        from engine.wf_ti import GpuResearchContext
        from datetime import datetime, timedelta, timezone
        from engine.runtime import initialize_runtime
        initialize_runtime("f64", require_cuda=True)
        start = datetime(2025, 1, 1, tzinfo=timezone.utc)
        bars = [{"time": (start+timedelta(minutes=15*i)).isoformat(), "_factor_market": "crypto_ohlcv_v1",
                 "open": 100+np.sin(i/13), "close": 100+np.sin(i/13), "high": 102+np.sin(i/13),
                 "low": 98+np.sin(i/13), "volume": 1000+i%19} for i in range(701)]
        resident = compute_features(bars)
        context = GpuResearchContext(bars, "15m", .0003, resident=resident)
        original = context.factor_context([0], 0, 513)
        with patch("engine.wf_ti.compute_features", side_effect=AssertionError("Repeated prefix features")):
            reused = context.factor_context([0], 0, 513, recompute=True)
        self.assertIs(original, reused)
        self.assertIs(reused["features"].matrix, resident.matrix)
        self.assertEqual(reused["features"].to_numpy().tobytes(), resident.to_numpy()[:, :513].tobytes())
        context.dispose()

    @classmethod
    def setUpClass(cls):
        initialize_runtime("f64", require_cuda=True)

    def assert_metrics(self, actual, expected):
        if expected is None:
            self.assertIsNone(actual)
            return
        self.assertEqual(set(actual), set(expected))
        for name, value in expected.items():
            self.assertAlmostEqual(actual[name], value, delta=1e-8, msg=name)

    def test_full_prefix_and_limited_warmup_slice_metrics(self):
        from engine.wf_ti import GpuResearchContext, evaluate_on_slice
        for crypto, tokens in ((True, [0, 77, 1, 93]), (False, [0, 1, 93])):
            bars = prepare_bars({"crypto_profile": crypto, "symbol": "ETHUSDT"}, feature_bars(1537))
            expected = cpu_slice(tokens, bars, 600, 1200, "15m", .0003)
            with patch("factor_lab.features.compute_features", side_effect=AssertionError("CPU features")):
                context = GpuResearchContext(bars, "15m", .0003)
                actual = evaluate_on_slice(context, tokens, 600, 1200)
            self.assert_metrics(actual, expected)
            self.assertEqual(actual, evaluate_on_slice(context, tokens, 600, 1200))
            self.assertIsNone(evaluate_on_slice(context, tokens, 600, 719))

    def test_legacy_fold_overlap_and_v2_validation_only_folds(self):
        from engine.wf_ti import GpuResearchContext, walk_forward_eval
        tokens = [0, 1, 64]
        for v2 in (False, True):
            cfg = {"symbol": "ETHUSDT", "crypto_profile": True}
            if v2:
                cfg["research_profile"] = "crypto_local_v2"
            bars = prepare_bars(cfg, feature_bars(4801))
            context = GpuResearchContext(bars, "15m", .0003)
            if v2:
                plan = build_split_plan(len(bars), bars=bars, require_calendar_days=False)
                expected = cpu_wf_v2(tokens, bars, "15m", .0003, plan, 3)
                actual = walk_forward_eval(context, tokens, 3, plan=plan)
                for fold in actual["folds"]:
                    self.assertGreaterEqual(fold["score_start"], plan.train_end)
                    self.assertLessEqual(fold["score_end"], plan.validation_end)
            else:
                expected = cpu_wf(tokens, bars, "15m", .0003, 3, train_len=3600)
                actual = walk_forward_eval(context, tokens, 3, train_len=3600)
                self.assertEqual([f["in_train"] for f in actual["folds"]], [True, True, False])
            self.assertEqual(actual["wf_stable"], expected["wf_stable"])
            self.assertEqual(actual["n_oos_folds"], expected["n_oos_folds"])
            for key in ("wf_mean_test_sortino", "wf_mean_test_ann", "wf_consistency"):
                self.assertAlmostEqual(actual[key], expected[key], delta=1e-8, msg=key)
            for a, b in zip(actual["folds"], expected["folds"]):
                if v2:
                    self.assert_metrics(a, b)
                else:
                    self.assert_metrics(a["train"], b["train"])
                    self.assert_metrics(a["test"], b["test"])


if __name__ == "__main__":
    unittest.main()
