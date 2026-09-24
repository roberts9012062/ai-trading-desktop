"""加密币本地挖掘成本回归：python scripts/verify-crypto-mining-cost.py。"""

import json
import sys
import unittest
from datetime import datetime, timedelta
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "public" / "pykernel"))

import factor_local
from data.product_specs import get_product_spec
from factor_lab.features import feature_matrix
from factor_lab.scoring.evaluate import evaluate_factor
from factor_lab.scoring.periods import bars_per_year
from factor_lab.vm import execute


def make_bars(price=0.25, n=420):
    start = datetime(2026, 3, 28)
    return [
        {
            "time": (start + timedelta(minutes=15 * i)).isoformat(" "),
            "open": price * (1 + 0.03 * np.sin((i - 1) / 10)),
            "close": price * (1 + 0.03 * np.sin(i / 10)),
            "high": price * (1.04 + 0.03 * np.sin(i / 10)),
            "low": price * (0.96 + 0.03 * np.sin(i / 10)),
            "volume": 1000 + i % 17,
        }
        for i in range(n)
    ]


class CryptoMiningCostTests(unittest.TestCase):
    def test_crypto_specs_match_existing_server_model(self):
        for symbol, tick in [("adausdt", 0.0001), ("dogeusdt", 0.00001),
                             ("shibusdt", 1e-8), ("pepeusdt", 1e-8),
                             ("btcusdt", 0.1)]:
            with self.subTest(symbol=symbol):
                spec = get_product_spec(symbol)
                self.assertEqual(spec["multiplier"], 1)
                self.assertEqual(spec["tick_size"], tick)
                self.assertEqual(spec["open_fee"], 0.0005)

    def test_symbol_aliases_do_not_fall_back_to_futures(self):
        for symbol in ["ADAUSDT", "ADA-USDT", "ADA_USDT", "ADA/USDT",
                       "ADA-USDT-SWAP", "ADA/USDT:USDT"]:
            with self.subTest(symbol=symbol):
                self.assertAlmostEqual(factor_local.resolve_cost(symbol, make_bars(), None),
                                       factor_local.resolve_cost("adausdt", make_bars(), None))
                self.assertLess(factor_local.resolve_cost(symbol, make_bars(), None), 0.002)

    def test_low_price_coins_have_fractional_costs(self):
        for symbol, price, tick in [("adausdt", 0.25, 0.0001),
                                    ("dogeusdt", 0.1, 0.00001),
                                    ("shibusdt", 0.00001, 1e-8)]:
            with self.subTest(symbol=symbol):
                cost = factor_local.resolve_cost(symbol, [{"close": price}] * 100, None)
                self.assertAlmostEqual(cost, 0.0005 + tick / price)
                self.assertLess(cost, 0.01)

    def test_unknown_crypto_requires_an_explicit_cost(self):
        with self.assertRaisesRegex(ValueError, "成本|规格"):
            factor_local.resolve_cost("newcoinusdt", make_bars(0.00001), None)
        self.assertEqual(factor_local.resolve_cost("newcoinusdt", make_bars(), 0.001), 0.001)

    def test_explicit_cost_including_zero_is_preserved(self):
        for cost in [0, 0.0003, 0.002]:
            self.assertEqual(factor_local.resolve_cost("adausdt", make_bars(), cost), cost)

    def test_futures_cost_is_unchanged(self):
        self.assertAlmostEqual(factor_local.resolve_cost("rb8888", [{"close": 3000}], None),
                               0.0001 + 1 / 3000)

    def test_screenshot_failure_is_removed_without_hiding_losses(self):
        bars = [{**b, "close": 0.25} for b in make_bars(n=1000)]
        factor = np.sin(np.arange(len(bars)) / 8)
        close = np.full(len(bars), 0.25)
        periods = bars_per_year(bars, "15m")
        broken = evaluate_factor(factor, close, cost=4.0001, periods=periods)
        fixed = evaluate_factor(factor, close,
                                cost=factor_local.resolve_cost("adausdt", bars, None),
                                periods=periods)
        self.assertLess(broken["ann_ret"], -1000)
        self.assertGreater(fixed["ann_ret"], -10)
        self.assertLess(fixed["ann_ret"], 0)  # flat prices + costs must still lose
        self.assertEqual(fixed["composite"], 0)  # preserve OOS rejection

    def test_gpu_preparation_shard_and_precise_use_the_same_auto_cost(self):
        bars = make_bars()
        payload = {"symbol": "adausdt", "timeframe": "15m", "train_ratio": 0.7,
                   "top_n": 2, "candidates": [[0]], "walk_forward_folds": 0}
        for omitted in [False, True]:
            with self.subTest(omitted=omitted):
                p = dict(payload) if omitted else {**payload, "cost": None}
                features = json.loads(factor_local.run_mine_features(p, bars))
                self.assertLess(features["cost"], 0.002)
                train = bars[:features["train_len"]]
                expected = evaluate_factor(execute([0], feature_matrix(train)),
                                           np.array([b["close"] for b in train]),
                                           features["cost"], features["periods"])
                shard = json.loads(factor_local.run_mine_shard(p, bars))["evaluated"][0]
                precise = json.loads(factor_local.run_mine_precise(p, bars))["champions"][0]
                self.assertAlmostEqual(shard["metrics"]["ann_ret"], expected["ann_ret"])
                self.assertAlmostEqual(precise["metrics"]["ann_ret"], expected["ann_ret"], places=3)

    def test_cpu_search_and_steps_omitted_cost_matches_null(self):
        bars = make_bars()
        payload = {"symbol": "adausdt", "timeframe": "15m", "population": 8,
                   "generations": 1, "max_depth": 2, "top_n": 2, "seed": 42}
        self.assertEqual(json.loads(factor_local.run_search(payload, bars)),
                         json.loads(factor_local.run_search({**payload, "cost": None}, bars)))
        steps = []
        for i, p in enumerate([payload, {**payload, "cost": None}]):
            sid = f"crypto-cost-{i}"
            factor_local.mine_start(json.dumps({**p, "session_id": sid}), json.dumps(bars))
            try:
                steps.append(json.loads(factor_local.mine_step(sid)))
            finally:
                factor_local.mine_dispose(sid)
        self.assertEqual(steps[0], steps[1])


if __name__ == "__main__":
    unittest.main(verbosity=2)
