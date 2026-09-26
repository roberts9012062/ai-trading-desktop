"""Real-kernel regression tests for crypto local mining (no network required)."""
import json
import sys
import unittest
from datetime import datetime, timedelta
from pathlib import Path
from unittest.mock import patch

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "public" / "pykernel"))
import factor_local
from factor_lab.features import active_feature_ids, bars_signature, feature_matrix, FEATURE_NAMES
from factor_lab.market import prepare_bars
from factor_lab.ops import OPS_NAMES, ts_centered_rank, ts_decay_linear
from factor_lab.scoring.periods import bars_per_year
from factor_lab.scoring.walk_forward import evaluate_on_slice
from factor_lab.search import SearchConfig, search_stepwise, _training_evaluator
from factor_lab.vm import execute


def bars(n=900):
    rng = np.random.default_rng(713)
    prices = 100 * np.exp(np.cumsum(rng.normal(0, .012, n)))
    return [dict(time=(datetime(2025, 1, 1) + timedelta(hours=i)).isoformat(),
                 open=float(p * .999), close=float(p), high=float(p * 1.01),
                 low=float(p * .99), volume=float(rng.uniform(500, 1500)))
            for i, p in enumerate(prices)]


PAYLOAD = dict(symbol="BTCUSDT", timeframe="60m", crypto_profile=True,
               train_ratio=.7, selection_v2=True, population=12, generations=3,
               top_n=2, seed=42, cost=.001)


class CryptoProfileTests(unittest.TestCase):
    def test_calendar_and_legacy(self):
        raw = bars()
        marked = prepare_bars(PAYLOAD, raw)
        self.assertEqual(bars_per_year(marked, "60m"), 8760)
        self.assertEqual(bars_per_year(marked, "1m"), 525600)
        self.assertEqual(bars_per_year(marked, "1d"), 365)
        self.assertEqual(bars_per_year(raw, "1d"), 243)
        self.assertNotIn("_factor_market", raw[0])
        mat = feature_matrix(marked)
        self.assertTrue(np.all(np.abs(mat[40:45]) <= 1))
        self.assertFalse(np.allclose(mat[40, 15:21], mat[40, 15]))
        # Same instant, two representations, exact same new calendar features.
        a = [dict(raw[0], time="2025-01-04 08:00:00")]
        b = [dict(raw[0], time="2025-01-04T00:00:00Z")]
        np.testing.assert_array_equal(feature_matrix(a)[40:45], feature_matrix(b)[40:45])

    def test_availability_and_prefix(self):
        raw = bars(800)
        mat = feature_matrix(raw)
        active = active_feature_ids(mat, True)
        self.assertTrue({14, 15, 16, 17, 18, 27, 28, 29, 30, 33, 34}.isdisjoint(active))
        self.assertIn(45, active)
        prefix = feature_matrix(raw[:500])
        np.testing.assert_allclose(prefix[40:], mat[40:, :500], rtol=0, atol=1e-10)
        for op in range(104, 108):
            np.testing.assert_allclose(execute([45, op], prefix), execute([45, op], mat)[:500], atol=1e-9)

    def test_direct_features_availability_causality_and_cache(self):
        raw = bars(800)
        for i, b in enumerate(raw):
            b.update(funding_rate=.0001 * np.sin(i // 8), quote_volume=b["close"] * b["volume"],
                     taker_buy_volume=b["volume"] * (.5 + .2 * np.sin(i)), trade_count=100 + i % 37,
                     long_short_ratio=1 + .1 * np.cos(i), liquidation_imbalance=np.sin(i / 4))
        mat = feature_matrix(raw)
        self.assertTrue(set(range(52, 59)).issubset(active_feature_ids(mat, True)))
        np.testing.assert_allclose(feature_matrix(raw[:500])[52:], mat[52:, :500], atol=1e-10)
        absent = bars(800)
        self.assertTrue(set(range(52, 59)).isdisjoint(active_feature_ids(feature_matrix(absent), True)))
        changed = [dict(b) for b in raw]
        changed[30]["funding_rate"] *= 3
        self.assertNotEqual(bars_signature(raw), bars_signature(changed))
        # A missing observation cannot be interpreted as a zero funding payment.
        changed[400]["funding_rate"] = None
        incomplete = feature_matrix(changed)
        self.assertNotIn(52, active_feature_ids(incomplete, True))
        self.assertIsNone(execute([52], incomplete))
        wire = factor_local.run_mine_features(PAYLOAD, changed)
        self.assertNotIn("NaN", wire)
        self.assertNotIn(52, json.loads(wire)["active_feature_ids"])
        # Known real zero rates are valid, though a constant sequence is unsampled.
        for b in changed:
            b["funding_rate"] = 0
        self.assertTrue(np.isfinite(feature_matrix(changed)[52]).all())

    def test_ops_and_ids(self):
        self.assertEqual(len(FEATURE_NAMES), 62)
        self.assertEqual(OPS_NAMES[38:40], ("EMA_5", "EMA_20"))
        self.assertEqual(OPS_NAMES[40], "TS_CRANK_20")
        np.testing.assert_array_equal(ts_centered_rank(np.ones(30), 20), np.zeros(30))
        x = np.array([1., 2., 2., 0.])
        np.testing.assert_allclose(ts_centered_rank(x, 3), [0, .5, 1/3, -2/3])
        np.testing.assert_allclose(ts_decay_linear(x, 3), [1, 5/3, 11/6, 1])
        self.assertTrue(factor_local._mark_local_only({}, [0, 104])["local_only"])
        self.assertFalse(factor_local._mark_local_only({}, [0, 103])["local_only"])

    def test_cache_identity(self):
        raw = bars(50)
        changed = [dict(b) for b in raw]
        changed[7]["volume"] *= 3
        self.assertNotEqual(bars_signature(raw), bars_signature(changed))
        self.assertNotEqual(bars_signature(raw), bars_signature(prepare_bars(PAYLOAD, raw)))
        self.assertFalse(np.array_equal(feature_matrix(raw), feature_matrix(changed)))

    def test_cost_ignores_holdout_prices(self):
        raw = bars(1000)
        req = dict(PAYLOAD, cost=None)
        base = factor_local.resolve_search_cost(req, raw)
        changed = [dict(b) for b in raw]
        for b in changed[700:]:
            b["close"] *= 100
        self.assertEqual(base, factor_local.resolve_search_cost(req, changed))
        near = np.array([1., 1. + 1e-8, 1. - 1e-8])
        np.testing.assert_array_equal(ts_centered_rank(near, 20), np.zeros(3))

    def test_training_cache(self):
        raw = bars(300)
        evaluate = _training_evaluator(feature_matrix(raw), np.array([b["close"] for b in raw]), .001, 8760)
        a = evaluate((45, 106))
        b = evaluate((45, 106))
        self.assertIs(a, b)
        self.assertEqual(evaluate.cache_info().hits, 1)

    def test_stepwise_final_holdout_only(self):
        raw = prepare_bars(PAYLOAD, bars(1000))
        cfg = SearchConfig(**{k:v for k,v in PAYLOAD.items() if k not in ("symbol", "timeframe")})
        steps = list(search_stepwise(raw, "60m", cfg))
        self.assertEqual(len(steps), 3)
        self.assertTrue(steps[-1].champions)
        for step in steps[:-1]:
            self.assertTrue(all("holdout_metrics" not in c.metrics for c in step.champions))
        self.assertTrue(all("holdout_metrics" in c.metrics for c in steps[-1].champions))
        self.assertTrue(all(c.metrics["periods"] == 8760 for c in steps[-1].champions))

    def test_gpu_session_and_cpu_same_inputs(self):
        raw = bars(1000)
        cfg = dict(PAYLOAD, gpu_session_id="crypto-test")
        try:
            features = json.loads(factor_local.run_mine_features(cfg, raw))
            self.assertEqual(features["periods"], 8760)
            self.assertNotIn(14, features["active_feature_ids"])
            req = dict(cfg, candidates=[[45, 106], [49, 104]], final_generation=False)
            pre = json.loads(factor_local.run_mine_precise(req, []))
            self.assertTrue(all("holdout_metrics" not in c["metrics"] for c in pre["champions"]))
            final = json.loads(factor_local.run_mine_precise(dict(req, final_generation=True), []))
            stateless = json.loads(factor_local.run_mine_precise({k:v for k,v in dict(req, final_generation=True).items() if k != "gpu_session_id"}, raw))
            self.assertEqual(final, stateless)
            self.assertTrue(final["champions"])
        finally:
            factor_local._GPU_INPUTS.pop("crypto-test", None)

    def test_nested_warmup_uses_prefix(self):
        raw = prepare_bars(PAYLOAD, bars(1200))
        import factor_lab.scoring.walk_forward as wf
        actual = wf.execute_for_bars
        observed = []
        def capture(tokens, matrix, bars, norm_window=None):
            observed.append(matrix.shape[1])
            return actual(tokens, matrix, bars, norm_window)
        with patch.object(wf, "execute_for_bars", capture):
            self.assertIsNotNone(evaluate_on_slice([45, 106, 107], raw, 800, 1100, "60m", .001))
        self.assertEqual(observed, [1100])


if __name__ == "__main__":
    unittest.main()
