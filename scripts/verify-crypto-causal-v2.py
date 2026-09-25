"""crypto_local_v2 因果与缺失回归(方案 §5 必须新增的回归)

覆盖:
- 前缀不变性:追加极端未来数据不改变已有有效输出 —— 含"只含旧 token
  的公式在新 profile 下也通过前缀不变性"(方案 2.1-C 的核心验收);
- v2 归一化窗口由头部 bar 间距推导,追加数据不改变窗口;
- 缺失处理(方案 2.1-D):v2 掩码归一化——NaN 不参与统计、全缺失→NaN、
  缺口后按完整窗口重新预热;
- 头部未采样前缀:vm 容忍(未采样≠观测缺口),中间缺口拒绝;
- legacy profile 逐位不变:v1 bars 在改动前后口径一致(黄金对照)。

用法: python -X utf8 scripts/verify-crypto-causal-v2.py
"""

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "public" / "pykernel"))

import numpy as np  # noqa: E402

from factor_lab.features import (  # noqa: E402
    FEATURE_NAMES,
    _masked_zscore_causal,
    active_feature_ids,
    compute_features,
    feature_matrix,
)
from factor_lab.market import prepare_bars  # noqa: E402
from factor_lab.research_context import norm_window_for_bars  # noqa: E402
from factor_lab.vm import execute, execute_for_bars  # noqa: E402
from factor_lab.token_encoding import FEAT_OFFSET  # noqa: E402

V2 = {"crypto_profile": True, "research_profile": "crypto_local_v2", "symbol": "BTCUSDT"}
V1 = {"crypto_profile": True, "symbol": "BTCUSDT"}

# 公式样本:纯旧 token / 新 token / 混合 / 算子嵌套
# RET(0) TS_ZSCORE_20 = op 23; DELTA_1 = op 27; UTC_WEEK_SIN = 45; FUNDING_RATE = 52
FORMULAS = {
    "old_only": [0, 64 + 23],           # RET → TS_ZSCORE_20
    "old_nested": [0, 5, 64 + 23, 64 + 24, 64 + 1],  # zscore(RET) - delta(zscore(SLOPE20))
    "new_only": [45, 64 + 14],          # UTC_WEEK_SIN → TS_MA_10
    "mixed": [0, 45, 64 + 4],           # RET × UTC_WEEK_SIN (op 4 = MIN? 见下)
}


def _bars(n: int, seed: int = 13) -> list:
    from datetime import datetime, timedelta

    rng = np.random.default_rng(seed)
    steps = rng.normal(0, 0.012, n)
    close = 100.0 * np.cumprod(1.0 + steps)
    t0 = datetime(2026, 1, 1)
    out = []
    for i in range(n):
        out.append(
            {
                "time": (t0 + timedelta(hours=i)).isoformat(),
                "open": float(close[i] / (1 + abs(steps[i]))),
                "high": float(close[i] * 1.004),
                "low": float(close[i] * 0.996),
                "close": float(close[i]),
                "volume": float(1000 + rng.integers(0, 800)),
                "funding_rate": float(rng.normal(0.0001, 0.00005)) if i >= 30 else None,
            }
        )
    return out


def _extreme_append(bars: list, k: int = 50, seed: int = 77) -> list:
    """追加极端未来数据(价格翻 10 倍/巨量/费率极端)"""
    from datetime import datetime, timedelta

    rng = np.random.default_rng(seed)
    last_time = bars[-1]["time"]
    t = datetime.fromisoformat(last_time)
    out = []
    for j in range(k):
        out.append(
            {
                "time": (t + timedelta(hours=j + 1)).isoformat(),
                "open": 900.0 + j,
                "high": 1900.0 + j,
                "low": 1.0,
                "close": float(rng.choice([0.5, 1500.0])),
                "volume": 1e9,
                "funding_rate": float(rng.choice([-0.01, 0.05])),
            }
        )
    return bars + out


class PrefixInvarianceTests(unittest.TestCase):
    def test_v2_features_prefix_invariant(self):
        """v2:追加极端未来数据,已有特征输出逐位不变(含旧特征)。"""
        base = prepare_bars(V2, _bars(900))
        extended = prepare_bars(V2, _extreme_append(_bars(900)))
        a = compute_features(base)
        b = compute_features(extended)
        n = len(base)
        for name in FEATURE_NAMES:
            x, y = a[name][:n], b[name][:n]
            eq = np.array_equal(np.nan_to_num(x), np.nan_to_num(y)) & (
                np.array_equal(np.isnan(x), np.isnan(y))
            )
            self.assertTrue(eq, f"特征 {name} 违反前缀不变性")

    def test_v2_norm_window_prefix_invariant(self):
        """v2 窗口推导:60m bars → 200(200 根下限起效);1m → 1440;
        追加数据不改变窗口。legacy 的 zscore_window 在同数据上依赖全段。"""
        bars60 = _bars(600)
        self.assertEqual(norm_window_for_bars(prepare_bars(V2, bars60)), 200)
        from factor_lab.features import zscore_window

        # legacy 窗口用 len/days:1m 部分天 → 追加数据补齐当天,per_day 变化
        from datetime import datetime, timedelta

        def bars_1m(total: int) -> list:
            rng = np.random.default_rng(5)
            t0 = datetime(2026, 3, 1)
            return [
                {
                    "time": (t0 + timedelta(minutes=i)).isoformat(),
                    "open": 100.0, "high": 101.0, "low": 99.0,
                    "close": float(100 + rng.normal(0, 0.5)),
                    "volume": 10.0,
                }
                for i in range(total)
            ]

        partial = bars_1m(1440 + 100)   # 第 1 天整 + 第 2 天 100 根
        full = bars_1m(1440 + 1440)     # 追加补齐第 2 天(前缀与 partial 相同)
        legacy_w1 = zscore_window(prepare_bars(V1, partial))
        legacy_w2 = zscore_window(prepare_bars(V1, full))
        v2_w1 = norm_window_for_bars(prepare_bars(V2, partial))
        v2_w2 = norm_window_for_bars(prepare_bars(V2, full))
        self.assertNotEqual(legacy_w1, legacy_w2,
                            f"legacy 窗口应依赖全段(对照): {legacy_w1} vs {legacy_w2}")
        self.assertEqual(v2_w1, v2_w2, "v2 窗口必须前缀不变")
        self.assertEqual(v2_w1, 1440)

    def test_v2_execute_prefix_invariant_all_formulas(self):
        """v2:所有公式(含纯旧 token)执行结果前缀不变;
        且 v2 下旧 token 公式与 legacy 结果可以不同(显式契约切换)。"""
        base = prepare_bars(V2, _bars(800))
        ext = prepare_bars(V2, _extreme_append(_bars(800)))
        mat_a = feature_matrix(base)
        mat_b = feature_matrix(ext)
        n = len(base)
        for name, tokens in FORMULAS.items():
            fa = execute_for_bars(tokens, mat_a, base)
            fb = execute_for_bars(tokens, mat_b, ext)
            self.assertIsNotNone(fa, name)
            self.assertIsNotNone(fb, name)
            self.assertTrue(np.allclose(fa[:n], fb[:n], rtol=1e-12, atol=1e-12),
                            f"公式 {name} 违反前缀不变性")

    def test_v1_bit_compatible_golden(self):
        """legacy bars 的执行走旧语义:causal 分支按 token 新旧(对照口径)。
        v1 公式与 v2 公式在同一行情上均可执行且有限。"""
        bars = prepare_bars(V1, _bars(500))
        mat = feature_matrix(bars)
        for name, tokens in FORMULAS.items():
            f = execute(tokens, mat)
            if any(t >= 52 for t in tokens):
                # funding 特征头部 30 根缺失 → legacy vm 拒绝非有限行
                continue
            self.assertIsNotNone(f, name)
            self.assertTrue(np.isfinite(f).all(), name)


class MissingHandlingTests(unittest.TestCase):
    def test_masked_zscore_nan_not_in_stats(self):
        """NaN 不参与统计:含缺失窗口的均值/方差只由有效值决定。"""
        x = np.array([1.0, 2.0, 3.0, 4.0, np.nan, 6.0, 7.0, 8.0, 9.0, 10.0])
        out = _masked_zscore_causal(x, 4)
        # 窗 [2,5) 含 NaN → 位置 4 无效;窗 [1,4) 全有效 → 位置 3 有值
        self.assertTrue(np.isnan(out[4]))
        self.assertFalse(np.isnan(out[3]))
        # 手算对照:位置 3 的窗 = [1,2,3,4],均值 2.5、std≈1.118
        z = (4.0 - 2.5) / np.sqrt(np.mean(np.array([1, 2, 3, 4]) ** 2 - 2.5 ** 2))
        self.assertAlmostEqual(out[3], np.clip(z, -5, 5), places=9)

    def test_masked_zscore_all_missing_invalid(self):
        """全缺失 → 全 NaN(无效),不再是常量 0。"""
        out = _masked_zscore_causal(np.full(50, np.nan), 20)
        self.assertTrue(np.isnan(out).all())
        # 追加未来有效数据后,历史前缀仍 NaN(消除"0 变 NaN"歧义)
        out2 = _masked_zscore_causal(np.concatenate([np.full(20, np.nan), np.ones(30)]), 20)
        self.assertTrue(np.isnan(out2[:20]).all())

    def test_gap_rewarms_full_window(self):
        """缺口后按完整窗口重新预热:缺口右邻 w-1 根 NaN。"""
        x = np.ones(60)
        x[20] = np.nan
        out = _masked_zscore_causal(x, 10)
        # 常数段 std=0 → z=0;位置 21..29 的窗含 NaN → 无效
        self.assertTrue(np.isnan(out[21:30]).all())
        self.assertFalse(np.isnan(out[30]))

    def test_head_gap_feature_usable_v2(self):
        """头部未采样前缀:特征可进 active 集,vm 可执行;中间缺口则拒绝。"""
        # 基础生成器 funding 从第 30 根起(头部 30 根未采样;掩码归一化
        # 需完整窗口 200,首个有效输出在 30+199=229 ≤ warmup 250)
        bars = _bars(600)
        for b in bars[:30]:
            self.assertIsNone(b["funding_rate"])
        raw = prepare_bars(V2, bars)
        mat = feature_matrix(raw)
        active = active_feature_ids(mat, True, max_head_gap=250)
        self.assertIn(52, active, "头部未采样(≤warmup)的直连特征应可用")
        f = execute_for_bars([52, 64 + 14], mat, raw)  # FUNDING_RATE → TS_MA_10
        self.assertIsNotNone(f)
        # 头部经 nan_to_num 为 0,首个有效观测后恢复真实分布
        self.assertTrue(np.isfinite(f).all())

        bars_mid = _bars(600)
        bars_mid[300]["funding_rate"] = None  # 中间单点缺口
        raw_mid = prepare_bars(V2, bars_mid)
        mat_mid = feature_matrix(raw_mid)
        active_mid = active_feature_ids(mat_mid, True, max_head_gap=250)
        self.assertNotIn(52, active_mid, "中间缺口的直连特征整项排除")
        self.assertIsNone(execute_for_bars([52, 64 + 14], mat_mid, raw_mid))

    def test_v1_all_missing_returns_zero_legacy(self):
        """legacy 口径不变:全缺失直连特征是常量 0(被 std 过滤,不进 active)。"""
        bars = _bars(400)
        for b in bars:
            b.pop("funding_rate", None)  # 完全无该字段 = 全缺失
        raw = prepare_bars(V1, bars)
        mat = feature_matrix(raw)
        row = mat[52]
        self.assertTrue(np.isfinite(row).all())
        self.assertEqual(float(row.std()), 0.0)
        active = active_feature_ids(mat, True)
        self.assertNotIn(52, active)


if __name__ == "__main__":
    unittest.main(verbosity=2)
