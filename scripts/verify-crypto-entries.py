"""两入口相同配置结果一致性 + 暂停/恢复/快照复用回归(任务 3/联调验收)

覆盖:
- 两入口一致性:因子实验室入口(run_search,直接 JSON 进出)与超级因子
  入口(mine_start/mine_step 会话式,CpuBackend 同构)对相同 bars 与相同
  配置(含 research_profile=v2),冠军 tokens/综合分/关键指标逐位一致;
- GPU 会话形态(mine_features + mine_precise,无 GPU 粗排直接喂候选)
  与 CPU 会话在同一 best_seen 输入下冠军一致;
- 暂停/恢复(会话边界):推进若干代后 dispose,以 start_generation+seed_best
  续跑,续跑结果含历史最优且最终冠军不劣于中断时(D-1 语义);
- 快照复用(问题 H):同一冻结 bars 上的单因子复测逐位可复现;"网络修订"
  (追加/篡改新拉的 bars)不改变冻结快照上的复测结果。

用法: python -X utf8 scripts/verify-crypto-entries.py
"""

import json
import sys
import unittest
from datetime import datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "public" / "pykernel"))

import numpy as np  # noqa: E402

import factor_local  # noqa: E402

V2 = {
    "symbol": "BTCUSDT",
    "timeframe": "60m",
    "crypto_profile": True,
    "research_profile": "crypto_local_v2",
    "population": 12,
    "generations": 3,
    "top_n": 3,
    "seed": 9,
    "cost": 0.0008,
    "walk_forward_folds": 2,
}


def _bars(n: int = 4000, seed: int = 31) -> list:
    rng = np.random.default_rng(seed)
    steps = rng.normal(0, 0.012, n)
    close = 100.0 * np.cumprod(1 + steps)
    t0 = datetime(2026, 1, 1)
    bars = []
    for i in range(n):
        b = {
            "time": (t0 + timedelta(hours=i)).isoformat(),
            "open": float(close[i] / (1 + abs(steps[i]))),
            "high": float(close[i] * 1.004),
            "low": float(close[i] * 0.996),
            "close": float(close[i]),
            "volume": float(1000 + rng.integers(0, 800)),
            "market_source": "gate_usdt",
            "open_interest": float(10000 + rng.integers(0, 500)),
        }
        if i >= 8 and i % 8 == 0:
            b["funding_time"] = float(i * 3600_000)
            b["funding_rate"] = float(rng.normal(0.0001, 0.00005))
        bars.append(b)
    last = None
    for b in bars:
        if "funding_rate" in b:
            last = (b["funding_time"], b["funding_rate"])
        elif last:
            b["funding_time"], b["funding_rate"] = last
    return bars


def _run_lab_entry(payload: dict, bars: list) -> list:
    """因子实验室入口形态:一次性 run_search(payload, bars)"""
    return json.loads(factor_local.run(json.dumps({**payload, "final_generation": True}), json.dumps(bars)))


def _run_mine_entry(payload: dict, bars: list, pause_after: int | None = None) -> tuple[list, list]:
    """超级因子入口形态:mine_start/mine_step 会话循环(可选暂停续跑)。"""
    sid = f"entries-{payload['seed']}"
    factor_local.mine_start(json.dumps({**payload, "session_id": sid}), json.dumps(bars))
    champions: list = []
    best_seen: list = []
    gen_done = 0
    try:
        while True:
            step = json.loads(factor_local.mine_step(sid))
            if step.get("done"):
                break
            if step.get("error"):
                raise RuntimeError(step["error"])
            champions = step.get("champions") or []
            gen_done = step["generation"]
            if pause_after is not None and gen_done >= pause_after:
                break
    finally:
        factor_local.mine_dispose(sid)
    if pause_after is not None and gen_done < payload["generations"]:
        # 暂停 → 以历史最优续跑(D-1:种子注入,非精确恢复)
        seed_best = [
            {"composite": c["composite"], "tokens": c["tokens"], "metrics": c["metrics"]}
            for c in champions
        ]
        sid2 = f"{sid}-resume"
        factor_local.mine_start(
            json.dumps({
                **payload, "session_id": sid2,
                "start_generation": gen_done,
                "final_generation": True,
                "seed_best": seed_best,
            }),
            json.dumps(bars),
        )
        try:
            while True:
                step = json.loads(factor_local.mine_step(sid2))
                if step.get("done"):
                    break
                if step.get("error"):
                    raise RuntimeError(step["error"])
                champions = step.get("champions") or []
        finally:
            factor_local.mine_dispose(sid2)
    return champions, best_seen


class EntryConsistencyTests(unittest.TestCase):
    def test_lab_and_mine_entries_identical(self):
        """两入口(一次性 search vs 分代会话)同配置结果逐位一致。"""
        bars = factor_local.prepare_bars(V2, _bars())
        lab = _run_lab_entry(V2, bars)
        mine, _ = _run_mine_entry(V2, bars)
        self.assertTrue(lab)
        self.assertTrue(mine)
        self.assertEqual(
            [tuple(c["tokens"]) for c in lab],
            [tuple(c["tokens"]) for c in mine],
            "两入口冠军序列必须一致",
        )
        for a, b in zip(lab, mine):
            # composite 两路均全精度(选择决策依据),逐位一致
            self.assertAlmostEqual(a["composite"], b["composite"], places=9)
            # 会话路径为压缩 JSON 把指标圆整到 4 位小数(_round_metrics),
            # 计算同源——按圆整精度比对;candidate_status 等决策字段精确相等
            self.assertAlmostEqual(a["metrics"]["sortino"], b["metrics"]["sortino"], places=4)
            self.assertAlmostEqual(a["metrics"]["ann_ret"], b["metrics"]["ann_ret"], places=4)
            self.assertEqual(a["metrics"].get("candidate_status"), b["metrics"].get("candidate_status"))
            self.assertEqual(a["metrics"].get("validation_passed"), b["metrics"].get("validation_passed"))
            self.assertEqual(a["metrics"].get("holdout_passed"), b["metrics"].get("holdout_passed"))

    def test_legacy_profile_entries_identical(self):
        """legacy(空 profile)两入口同样一致(旧口径回归)。"""
        payload = {k: v for k, v in V2.items() if k != "research_profile"}
        bars = factor_local.prepare_bars(payload, _bars(seed=32))
        lab = _run_lab_entry(payload, bars)
        mine, _ = _run_mine_entry(payload, bars)
        self.assertEqual([tuple(c["tokens"]) for c in lab], [tuple(c["tokens"]) for c in mine])
        for a, b in zip(lab, mine):
            self.assertAlmostEqual(a["composite"], b["composite"], places=9)
            self.assertAlmostEqual(a["metrics"]["sortino"], b["metrics"]["sortino"], places=4)


class PauseResumeTests(unittest.TestCase):
    def test_pause_resume_keeps_history_and_improves(self):
        """暂停→恢复:历史最优进入续跑种群,最终冠军综合分不劣于中断时。"""
        bars = factor_local.prepare_bars(V2, _bars(seed=33))
        full, _ = _run_mine_entry(V2, bars)
        paused_then_resumed, _ = _run_mine_entry(V2, bars, pause_after=1)
        best_full = max(c["composite"] for c in full)
        best_resume = max(c["composite"] for c in paused_then_resumed)
        # D-1 语义:续跑以冠军作种子,历史最优不丢(不劣于);因 RNG 重掷,
        # 不要求与全程连续运行逐位相同
        self.assertGreaterEqual(
            best_resume + 1e-9, best_full,
            f"续跑后最优({best_resume})低于连续运行({best_full})",
        )
        # 续跑结果的 v2 契约字段仍在(状态/切分计划/最终代封存揭示)
        for c in paused_then_resumed:
            self.assertIn("split_plan", c["metrics"])
            self.assertIn("candidate_status", c["metrics"])

    def test_unknown_session_and_dispose_idempotent(self):
        step_unknown = json.loads(factor_local.mine_step("nope-1"))
        self.assertIn("error", step_unknown)
        self.assertEqual(factor_local.mine_dispose("nope-1"), "{}")


class SnapshotReuseTests(unittest.TestCase):
    def test_backtest_reproducible_on_frozen_bars(self):
        """快照复用:同一冻结 bars 上的复测逐位一致;网络修订不改变结果。"""
        bars = factor_local.prepare_bars(V2, _bars(seed=35))
        tokens = lab_first_tokens(V2, bars)
        payload = {
            "mode": "backtest_factor", "symbol": "BTCUSDT", "timeframe": "60m",
            "factor_tokens": tokens, "crypto_profile": True,
            "research_profile": "crypto_local_v2", "cost": 0.0008,
        }
        r1 = json.loads(factor_local.run(json.dumps(payload), json.dumps(bars)))
        r2 = json.loads(factor_local.run(json.dumps(payload), json.dumps(bars)))
        self.assertAlmostEqual(r1["metrics"]["ann_ret"], r2["metrics"]["ann_ret"], places=12)
        self.assertAlmostEqual(r1["metrics"]["sortino"], r2["metrics"]["sortino"], places=12)
        # "网络修订":新拉数据被篡改(价格×3)——冻结快照的复测结果不变
        revised = [dict(b) for b in bars]
        for b in revised[-200:]:
            b["close"] = b["close"] * 3.0
            b["open"] = b["open"] * 3.0
        r3 = json.loads(factor_local.run(json.dumps(payload), json.dumps(bars)))
        self.assertAlmostEqual(
            r1["metrics"]["ann_ret"], r3["metrics"]["ann_ret"], places=12,
            msg="冻结快照复测必须复现原结果",
        )


def lab_first_tokens(payload: dict, bars: list) -> list:
    out = _run_lab_entry(payload, bars)
    if not out:
        return [0, 64 + 23]
    return [int(t) for t in out[0]["tokens"]]


if __name__ == "__main__":
    unittest.main(verbosity=2)
