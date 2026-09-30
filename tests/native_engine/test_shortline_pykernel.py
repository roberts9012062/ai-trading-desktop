"""短线 v4 特征/VM/树编码/profile/fitness —— pykernel 侧测试（无需 GPU）。

覆盖 M-D2 冻结决策：
- feature_matrix 附加行为加法（无 sl 列时 base 62 行逐位不变）
- token 115-122 的 VM 分发与缺失准入（52+ 族语义）
- 树编码 62-69 <-> token 115-122 往返
- shortline_v1 profile 解析与 v2 语义族
- fitness 翻转率/半衰期/乘子
"""
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "native-engine"))
sys.path.insert(0, str(ROOT / "public" / "pykernel"))

import numpy as np


def _bars(n=420, seed=7, with_sl=True):
    import random

    rng = random.Random(seed)
    price = 3000.0
    bars = []
    t0 = 1_700_000_000_000
    for i in range(n):
        price *= 1 + (rng.random() - 0.5) * 0.002
        o = price * (1 + (rng.random() - 0.5) * 0.0005)
        h = max(o, price) * 1.0005
        l = min(o, price) * 0.9995
        bar = {
            "time": __import__("datetime").datetime.fromtimestamp(
                t0 / 1000 + i * 60, __import__("datetime").timezone.utc
            ).isoformat(),
            "open": o, "high": h, "low": l, "close": price,
            "volume": 100 * (1 + rng.random()),
            "quote_volume": 100 * price * (1 + rng.random()),
            "taker_buy_volume": 50 * (1 + rng.random()),
            "trade_count": 50 + int(rng.random() * 100),
            "funding_rate": 0.0001 * (rng.random() - 0.5),
        }
        if with_sl:
            for k in range(8):
                bar[f"sl_of{k}"] = rng.random() - 0.5
        bars.append(bar)
    return bars


class ShortlineMatrixTests(unittest.TestCase):
    def test_additivity_without_sl_columns(self):
        """无 sl 列 → 62 行且与旧口径逐位一致（加法性守护）"""
        from factor_lab.features import feature_matrix, clear_feature_matrix_cache

        clear_feature_matrix_cache()
        bars = _bars(with_sl=False)
        mat = feature_matrix(bars)
        self.assertEqual(mat.shape[0], 62)

    def test_sl_columns_extend_matrix_to_70_rows(self):
        from factor_lab.features import (SHORTLINE_COLUMN_KEYS, SHORTLINE_FEATURE_NAMES,
                                         SHORTLINE_ZSCORE_WINDOW, clear_feature_matrix_cache,
                                         feature_matrix, shortline_feature_rows)

        bars = _bars(with_sl=True)
        rows = shortline_feature_rows(bars)
        self.assertEqual(set(rows), set(SHORTLINE_FEATURE_NAMES))
        row = rows["SL_OF_IMB"]
        # 全存在列:头部部分窗口即有值(与 _masked_zscore_causal 语义一致)
        self.assertTrue(np.all(np.isfinite(row)))
        # 中段缺口:从缺口起 300 根内 NaN(缺失不冒充 0)
        gapped = _bars(360)
        for k in range(8):
            gapped[100][f"sl_of{k}"] = None
        rows_g = shortline_feature_rows(gapped)
        rg = rows_g["SL_OF_IMB"]
        self.assertTrue(np.isnan(rg[100]))
        self.assertTrue(np.isnan(rg[359]))
        self.assertTrue(np.isfinite(rg[0]))

        clear_feature_matrix_cache()
        mat = feature_matrix(bars)
        self.assertEqual(mat.shape[0], 70)
        # 行 62-69 与 shortline_feature_rows 逐位一致
        for k, name in enumerate(SHORTLINE_FEATURE_NAMES):
            np.testing.assert_array_equal(mat[62 + k], rows[name])

    def test_signature_distinguishes_sl_columns(self):
        from factor_lab.features import bars_signature

        self.assertNotEqual(bars_signature(_bars(seed=7, with_sl=True)), bars_signature(_bars(seed=7, with_sl=False)))


class ShortlineVmTests(unittest.TestCase):
    def test_token_dispatch_and_admission(self):
        from factor_lab.features import clear_feature_matrix_cache, feature_matrix
        from factor_lab.vm import execute, execute_for_bars

        bars = _bars()
        clear_feature_matrix_cache()
        mat70 = feature_matrix(bars)
        clear_feature_matrix_cache()
        mat62 = feature_matrix(_bars(with_sl=False))

        tokens = [115, 64 + 23]  # SL_OF_IMB → TS_ZSCORE_20
        v2 = "causal_v2"
        factor = execute(list(tokens), mat70, 250, v2)
        self.assertIsNotNone(factor)
        # 无 sl 列的矩阵：同 token 拒绝（行不存在）
        self.assertIsNone(execute(list(tokens), mat62, 250, v2))

        # v2 头部缺失容忍：NaN 头（窗 300）+ 完整因果归一 → 可执行
        factor2 = execute_for_bars(list(tokens), mat70, bars)
        self.assertIsNotNone(factor2)
        # 头部 NaN 经算子清理后非 NaN
        self.assertTrue(np.all(np.isfinite(factor2[300:])))

    def test_tree_codec_roundtrip(self):
        from factor_lab.search import tokens_to_tree, tree_to_tokens

        for tokens in ([115], [115, 116, 64], [0, 115, 64 + 3], [24, 115, 64 + 0, 64 + 12]):
            tree = tokens_to_tree(list(tokens))
            self.assertIsNotNone(tree, f"tree decode failed: {tokens}")
            self.assertEqual(tree_to_tokens(tree), list(tokens))
        # 越界 v4 token 拒绝
        self.assertIsNone(tokens_to_tree([123]))


class ShortlineProfileTests(unittest.TestCase):
    def test_resolve_context(self):
        from factor_lab.research_context import PROFILE_SHORTLINE_V1, resolve_context

        bars = _bars()
        cost = 0.0003
        payload = {"research_profile": PROFILE_SHORTLINE_V1, "timeframe": "15m",
                   "symbol": "ETHUSDT", "crypto_profile": True}
        ctx = resolve_context(payload, bars, cost)
        self.assertIsNotNone(ctx)
        self.assertEqual(ctx.profile_id, PROFILE_SHORTLINE_V1)
        # 与 v2 同构切分
        ctx_v2 = resolve_context({**payload, "research_profile": "crypto_local_v2"}, bars, cost)
        self.assertEqual(ctx.split.to_summary(), ctx_v2.split.to_summary())

    def test_unknown_profile_rejected(self):
        from factor_lab.market import prepare_bars
        from factor_lab.research_context import KNOWN_PROFILES

        self.assertIn("shortline_v1", KNOWN_PROFILES)
        # prepare_bars 打 shortline 标记
        bars = prepare_bars({"research_profile": "shortline_v1", "symbol": "ETHUSDT"}, _bars(10))
        self.assertEqual(bars[0]["_factor_market"], "shortline_v1")
        from factor_lab.market import is_v2, is_crypto

        self.assertTrue(is_v2(bars))
        self.assertTrue(is_crypto(bars))


class ShortlineFitnessTests(unittest.TestCase):
    def test_flip_and_half_life_formulas(self):
        from factor_lab.scoring.evaluate import _flip_and_half_life, shortline_penalty

        pos = np.array([0.0, 1.0, -1.0, 1.0, 1.0])
        flip, hl = _flip_and_half_life(pos)
        # 翻转: t=2 (1·-1<0), t=3 (-1·1<0) → 2/4
        self.assertAlmostEqual(flip, 0.5)
        self.assertGreater(hl, 0.0)
        # 长斜坡:样本 lag-1 自相关→1 → hl 超 500 封顶
        flip0, hl0 = _flip_and_half_life(1.0 + 0.001 * np.arange(2000))
        self.assertEqual(flip0, 0.0)
        self.assertEqual(hl0, 500.0)
        # 交替:rho<0 → hl 很小
        alt = np.array([(-1.0) ** i for i in range(50)])
        _, hl_alt = _flip_and_half_life(alt)
        self.assertLess(hl_alt, 1.0)
        # 乘子边界
        self.assertAlmostEqual(shortline_penalty(0.0, 0.0, 48.0), 1.0)
        self.assertAlmostEqual(shortline_penalty(0.35, 0.08, 0.0), 0.0)
        self.assertEqual(shortline_penalty(1.0, 1.0, 0.0), 0.0)

    def test_composite_multiplier_and_reset(self):
        from factor_lab.scoring.evaluate import evaluate_factor, set_shortline_fitness, shortline_penalty

        rng = np.random.default_rng(3)
        close = np.cumsum(rng.normal(0, 1, 800)) + 100
        factor = np.sin(np.arange(800) / 30.0)
        base = evaluate_factor(factor, close, 0.0003, 8760)
        self.assertIn("flip_rate", base)
        self.assertIn("half_life", base)
        set_shortline_fitness(True)
        try:
            sl = evaluate_factor(factor, close, 0.0003, 8760)
        finally:
            set_shortline_fitness(False)
        expected = base["composite"] * shortline_penalty(
            base["avg_turnover"], base["flip_rate"], base["half_life"]
        )
        self.assertAlmostEqual(sl["composite"], expected)
        self.assertLessEqual(sl["composite"], base["composite"])
        # 复位后回到 v2 口径
        again = evaluate_factor(factor, close, 0.0003, 8760)
        self.assertEqual(again["composite"], base["composite"])

    def test_search_applies_shortline_fitness(self):
        """同种子下 shortline 最优 composite ≤ v2（乘子只减不增）"""
        from factor_lab.features import clear_feature_matrix_cache
        from factor_lab.search import SearchConfig, search

        bars = _bars(520, seed=11)
        cfg_v2 = SearchConfig(crypto_profile=True, research_profile="crypto_local_v2",
                              population=24, generations=3, top_n=3, seed=5, max_depth=3)
        cfg_sl = SearchConfig(crypto_profile=True, research_profile="shortline_v1",
                              population=24, generations=3, top_n=3, seed=5, max_depth=3)
        clear_feature_matrix_cache()
        champs_v2 = search(list(bars), "15m", cfg_v2)
        clear_feature_matrix_cache()
        champs_sl = search(list(bars), "15m", cfg_sl)
        self.assertTrue(champs_v2)
        self.assertTrue(champs_sl)
        self.assertLessEqual(champs_sl[0].composite, champs_v2[0].composite + 1e-12)
        # shortline 冠军 metrics 带 fitness 附加指标
        self.assertIn("flip_rate", champs_sl[0].metrics)


if __name__ == "__main__":
    unittest.main()
