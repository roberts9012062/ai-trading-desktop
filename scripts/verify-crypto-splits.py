"""crypto_local_v2 数据切分/边界回归(方案 §5 必须新增的回归)

覆盖:
- fix A:700/850 边界案例——跨训练边界的折不得计为样本外;
- fix B:120 根日线不得静默得到 OOS 通过(样本不足显式标记,不出验证通过);
- 修改封存段数据不改变训练候选/验证名单(封存对搜索不可见);
- v2 验证折只在验证区内切分,上下文可延伸进训练区;
- SplitPlan 充分性判定与缺口清单。

用法: python -X utf8 scripts/verify-crypto-splits.py
"""

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "public" / "pykernel"))

import numpy as np  # noqa: E402

import factor_local  # noqa: E402
from factor_lab.scoring.split_plan import (  # noqa: E402
    SplitPlan,
    boundary_folds_in_train,
    build_split_plan,
    plan_validation_folds,
)
from factor_lab.scoring.walk_forward import walk_forward_eval  # noqa: E402
from factor_lab.search import SearchConfig, search  # noqa: E402


def _bars(n: int, seed: int = 7, start_day: int = 1) -> list:
    """1h 加密 K 线(UTC 连续,7×24,时间戳严格单调递增)"""
    from datetime import datetime, timedelta

    rng = np.random.default_rng(seed)
    steps = rng.normal(0, 0.01, n)
    close = 100.0 * np.cumprod(1.0 + steps)
    t0 = datetime(2026, 1, 1)
    out = []
    for i in range(n):
        ts = (t0 + timedelta(hours=start_day - 1 + i)).isoformat()
        out.append(
            {
                "time": ts,
                "open": float(close[i] / (1 + abs(steps[i]))),
                "high": float(close[i] * 1.003),
                "low": float(close[i] * 0.997),
                "close": float(close[i]),
                "volume": float(1000 + rng.integers(0, 500)),
            }
        )
    return out


PAYLOAD = {
    "symbol": "BTCUSDT",
    "timeframe": "60m",
    "crypto_profile": True,
    "research_profile": "crypto_local_v2",
    "population": 12,
    "generations": 2,
    "top_n": 3,
    "cost": 0.0008,
    "seed": 11,
}


class SplitPlanTests(unittest.TestCase):
    def test_sufficient_plan_boundaries(self):
        """3600 根 1h(150 天):60/20/20 边界与充分性"""
        plan = build_split_plan(3600, label_span=1, warmup=250, bars=_bars(3600))
        self.assertTrue(plan.sufficient, plan.insufficiency_reasons)
        self.assertEqual(plan.train_end, 2160)
        self.assertEqual(plan.validation_end, 2880)
        self.assertEqual(plan.holdout_end, 3600)

    def test_insufficient_reports_gaps(self):
        """120 根日线:必须给出具体缺口,不得静默通过"""
        bars = _bars(120)
        plan = build_split_plan(120, label_span=1, warmup=250, bars=bars)
        self.assertFalse(plan.sufficient)
        self.assertTrue(any("train=" in r for r in plan.insufficiency_reasons))
        self.assertTrue(any("validation=" in r for r in plan.insufficiency_reasons))
        self.assertTrue(any("holdout=" in r for r in plan.insufficiency_reasons))

    def test_validation_folds_stay_in_region(self):
        """验证折计分区间 ⊆ [train_end, validation_end)"""
        plan = build_split_plan(3600, label_span=1, warmup=250, bars=_bars(3600))
        folds = plan_validation_folds(plan, 3)
        self.assertIsNotNone(folds)
        for a, b in folds:
            self.assertGreaterEqual(a, plan.validation_score_start)
            self.assertLessEqual(b, plan.validation_end)
            self.assertGreaterEqual(b - a, 60)
        # 折过密返回 None,不得降格
        self.assertIsNone(plan_validation_folds(plan, 50))

    def test_label_span_clears_tail(self):
        """label_span=3:末尾 2 根无完整标签,不计分"""
        plan = build_split_plan(3600, label_span=3, warmup=250, bars=_bars(3600))
        self.assertEqual(plan.tail_unclear_bars, 2)
        folds = plan_validation_folds(plan, 3)
        self.assertIsNotNone(folds)
        self.assertLess(folds[-1][1], plan.validation_end)


class BoundaryFoldTests(unittest.TestCase):
    def test_700_850_boundary_fold_not_oos(self):
        """fix A 核心:可见 850 根、训练 700 根、3 折——跨边界折不得计 OOS。

        折划分:seg=850//4=212,折 i 的 test=[i*212,(i+1)*212)(末折吃到 850)。
        折 3 的 test=[636,850) 与训练区 [0,700) 重叠 64 根——旧实现
        (test_end<=train_len)把它当纯样本外折参与 wf_stable。
        """
        bars = factor_local.prepare_bars(
            {"crypto_profile": True, "symbol": "BTCUSDT"}, _bars(850)
        )
        wf = walk_forward_eval([0], bars, "60m", 0.0008, 3, train_len=700)
        self.assertIsNotNone(wf)
        in_train_flags = [f["in_train"] for f in wf["folds"]]
        # 折1 [212,424)、折2 [424,636) 完全在训练区;折3 [636,850) 跨界
        self.assertEqual(in_train_flags, [True, True, True])
        self.assertEqual(wf["n_oos_folds"], 0)
        # 跨界折记录与训练区的重叠量(诊断字段)
        self.assertEqual(wf["folds"][2].get("overlap_train_bars"), 64)

    def test_interval_intersection_helper(self):
        folds = [(0, 100), (50, 200), (150, 300)]
        self.assertEqual(boundary_folds_in_train(folds, 150), [True, True, False])
        # (0,100) 起点在训练区内,仍是部分训练折
        self.assertEqual(boundary_folds_in_train(folds, 49), [True, False, False])
        self.assertEqual(boundary_folds_in_train(folds, 50), [True, False, False])
        self.assertEqual(boundary_folds_in_train(folds, 51), [True, True, False])


class SearchIntegrationTests(unittest.TestCase):
    def test_short_sample_no_silent_oos_pass(self):
        """fix B:120 根日线样本不足——结果带 insufficient_samples,
        任何冠军不得带 validation_passed。"""
        raw = factor_local.prepare_bars(dict(PAYLOAD, timeframe="1d"), _bars(120, seed=3))
        out = json_search(raw, dict(PAYLOAD, timeframe="1d", final_generation=True))
        self.assertTrue(out)
        for c in out:
            m = c["metrics"]
            self.assertTrue(m.get("insufficient_samples"), m)
            self.assertNotIn("validation_passed", m)
            self.assertEqual(m.get("candidate_status"), "exploratory")
            self.assertTrue(m.get("sample_gaps"))

    def test_holdout_invisible_to_search(self):
        """修改封存段行情不改变训练候选与验证名单(封存对搜索不可见)。"""
        # 4000 根 60m:验证/封存各 800 根(≥30 天),计划充分,封存从 3200 起
        bars_a = _bars(4000, seed=21)
        bars_b = [dict(b) for b in bars_a]
        # 篡改封存区 [3200, 4000) 的价格
        for b in bars_b[3200:]:
            b["close"] = float(b["close"]) * 3.7
            b["open"] = float(b["open"]) * 3.7
        raw_a = factor_local.prepare_bars(PAYLOAD, bars_a)
        raw_b = factor_local.prepare_bars(PAYLOAD, bars_b)
        # 只给搜索"可见段"(搜索入口自行裁剪;这里喂全量验证裁剪一致性)
        out_a = search(raw_a, "60m", _cfg(PAYLOAD))
        out_b = search(raw_b, "60m", _cfg(PAYLOAD))
        ta = [tuple(c.tokens) for c in out_a]
        tb = [tuple(c.tokens) for c in out_b]
        self.assertEqual(ta, tb, "封存段数据变化不得影响搜索结果")
        for ca, cb in zip(out_a, out_b):
            self.assertAlmostEqual(ca.composite, cb.composite, places=9)

    def test_v2_validation_folds_context_can_enter_train(self):
        """v2 验证折:上下文延伸进训练区,计分不越验证区。"""
        from factor_lab.scoring.walk_forward import walk_forward_eval_v2

        bars = factor_local.prepare_bars(PAYLOAD, _bars(3000, seed=5))
        plan = build_split_plan(3000, label_span=1, warmup=250, bars=bars)
        wf = walk_forward_eval_v2([0], bars, "60m", 0.0008, plan, 2)
        self.assertIsNotNone(wf)
        for fold in wf["folds"]:
            self.assertGreaterEqual(fold["score_start"], plan.train_end)
            self.assertLessEqual(fold["score_end"], plan.validation_end)
            self.assertLess(fold["context_start"], fold["score_start"])


def _cfg(payload) -> SearchConfig:
    kwargs = {
        k: payload[k]
        for k in (
            "crypto_profile", "research_profile", "population", "generations",
            "top_n", "cost", "seed", "walk_forward_folds",
        )
        if k in payload
    }
    return SearchConfig(**kwargs)


def json_search(bars, payload) -> list:
    return json.loads(factor_local.run_search(dict(payload), bars))


import json  # noqa: E402


if __name__ == "__main__":
    unittest.main(verbosity=2)
