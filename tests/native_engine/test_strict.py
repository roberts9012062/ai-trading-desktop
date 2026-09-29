"""Strict decisions retain CPU gate order, frozen splits and peer semantics."""
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(ROOT / "native-engine"), str(ROOT / "public/pykernel")]
from engine.runtime import initialize_runtime
from factor_lab.market import prepare_bars
from factor_lab.search import _strict_gate
from factor_local import _strict_eval_context
from test_features import feature_bars


class StrictTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        initialize_runtime("f64", require_cuda=True)

    def test_test_cost_wf_live_and_cross_peer_gates(self):
        from engine.strict_ti import StrictContext, strict_eval
        bars = feature_bars(2401)
        candidates = [[0], [1], [0, 1, 64], [0, 1, 65], [0, 0, 65]]
        peers = [("BTCUSDT", feature_bars(2401)), ("SOLUSDT", feature_bars(2401))]
        config = {"symbol": "ETHUSDT", "timeframe": "15m", "crypto_profile": True,
                  "train_ratio": .6, "cost": .00003, "walk_forward_folds": 2,
                  "live_fill_gate": True, "live_entry_gate": .3, "cross_peers": peers}
        bars = prepare_bars(config, bars)
        cpu = _strict_eval_context(config, bars)
        expected = [{"tokens": tokens, "pass": bool(result[0]), "cross_scores": result[1]}
                    for tokens in candidates for result in [_strict_gate(tokens, cpu)]]
        with patch("factor_lab.features.compute_features", side_effect=AssertionError("CPU features")):
            context = StrictContext(bars, config)
            actual = strict_eval(context, candidates)
        self.assertEqual([x["pass"] for x in actual], [x["pass"] for x in expected])
        for a, b in zip(actual, expected):
            self.assertEqual(set(a["cross_scores"]), set(b["cross_scores"]))
            for peer in b["cross_scores"]:
                self.assertAlmostEqual(a["cross_scores"][peer], b["cross_scores"][peer], delta=1e-8)
        self.assertEqual(actual, strict_eval(context, candidates))

    def test_v2_insufficient_and_sealed_holdout_context(self):
        from engine.strict_ti import StrictContext
        cfg = {"symbol": "ETHUSDT", "timeframe": "15m", "research_profile": "crypto_local_v2", "cost": .0003}
        bars = prepare_bars(cfg, feature_bars(2401))
        context = StrictContext(bars, cfg)
        self.assertFalse(context.metadata["plan"].sufficient)
        self.assertFalse(context.metadata["use_test"])
        # Calendar-spanning data makes the plan sufficient; the strict context
        # must end at validation_end and never retain sealed bars in scoring.
        from datetime import datetime, timedelta, timezone
        start = datetime(2024, 1, 1, tzinfo=timezone.utc)
        for i, b in enumerate(bars):
            b["time"] = (start + timedelta(hours=4*i)).isoformat()
        context = StrictContext(bars, {**cfg, "timeframe": "240m"})
        plan = context.metadata["plan"]
        self.assertTrue(plan.sufficient)
        self.assertEqual(len(context.bars), plan.validation_end)
        self.assertLess(len(context.bars), plan.holdout_end)


if __name__ == "__main__":
    unittest.main()
