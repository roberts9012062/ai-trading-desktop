"""组合因子(combo_super)CPU 内核回归:mine_portfolio 的 2× 双口径与折检验。

无网络依赖:合成随机行走 bars + 手工 token,直接驱动 run_mine_portfolio,
校验勾选/不勾选组合因子两种 payload 的返回结构(逐位回归 + 新口径语义)。
"""
import json
import sys
import unittest
from datetime import datetime, timedelta
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "public" / "pykernel"))
import factor_local


def bars(n=900):
    rng = np.random.default_rng(713)
    prices = 100 * np.exp(np.cumsum(rng.normal(0, .012, n)))
    return [dict(time=(datetime(2025, 1, 1) + timedelta(hours=i)).isoformat(),
                 open=float(p * .999), close=float(p), high=float(p * 1.01),
                 low=float(p * .99), volume=float(rng.uniform(500, 1500)))
            for i, p in enumerate(prices)]


# 一元时序算子 token(特征 0=close;88=DELTA_1 89=DELTA_5 78=TS_MA_10)
TOKENS = [
    [0, 88],
    [0, 89],
    [0, 78],
]


def run(payload_extra):
    payload = dict(symbol="BTCUSDT", timeframe="60m", crypto_profile=True,
                   cost=.001, tokens_list=[list(t) for t in TOKENS], **payload_extra)
    return json.loads(factor_local.run_mine_portfolio(payload, bars()))


class ComboSuperTests(unittest.TestCase):
    def test_legacy_payload_shape_unchanged(self):
        result = run(dict(train_ratio=.7))
        pf = result["portfolio"]
        self.assertIsNotNone(pf)
        # 旧口径:无 2× 字段、无折检验、无 super 判定(逐位一致约束)
        for key in ("equal_2x", "ic_weighted_2x", "best_single_2x", "combo_super",
                    "super_passed", "wf_fold_sortinos", "wf_stable"):
            self.assertNotIn(key, pf)
        self.assertEqual(pf["n_factors"], 3)

    def test_combo_super_dual_scale_and_folds(self):
        result = run(dict(train_ratio=.7, selection_v2=True,
                          combo_super=True, walk_forward_folds=3))
        pf = result["portfolio"]
        self.assertIsNotNone(pf)
        self.assertTrue(pf["combo_super"])
        # 2× 双口径:成本加倍后 Sortino 应不高于 1×(成本只增不减的保守校验)
        self.assertLessEqual(pf["equal_2x"]["sortino"], pf["equal"]["sortino"] + 1e-12)
        if pf["ic_weighted_2x"] is not None and pf["ic_weighted"] is not None:
            self.assertLessEqual(pf["ic_weighted_2x"]["sortino"], pf["ic_weighted"]["sortino"] + 1e-12)
        # 折检验:3 折各为一个 Sortino 数;wf_stable 与折明细一致
        folds = pf["wf_fold_sortinos"]
        self.assertEqual(len(folds), 3)
        self.assertTrue(all(np.isfinite(f) for f in folds))
        self.assertEqual(pf["wf_stable"], all(f > 0 for f in folds))
        # super_passed = (等权或 IC 加权 2×>0) 且对应折全正
        equal_ok = pf["equal_2x"]["sortino"] > 0 and pf["wf_stable"]
        ic_stable = (pf.get("wf_fold_sortinos_ic") is None
                     or all(f > 0 for f in pf["wf_fold_sortinos_ic"]))
        ic_ok = (pf["ic_weighted_2x"] is not None and pf["ic_weighted_2x"]["sortino"] > 0
                 and ic_stable)
        self.assertEqual(pf["super_passed"], bool(equal_ok or ic_ok))
        if pf["super_passed"]:
            self.assertIn(pf.get("pass_mode"), ("equal", "ic_weighted"))

    def test_zero_folds_skips_fold_check(self):
        result = run(dict(train_ratio=.7, combo_super=True, walk_forward_folds=0))
        pf = result["portfolio"]
        self.assertTrue(pf["combo_super"])
        self.assertTrue(pf["wf_stable"])
        self.assertNotIn("wf_fold_sortinos", pf)
        self.assertEqual(pf["super_passed"],
                         pf["equal_2x"]["sortino"] > 0 or
                         (pf["ic_weighted_2x"] or {"sortino": -1})["sortino"] > 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
