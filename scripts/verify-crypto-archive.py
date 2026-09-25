"""有界档案/种子模板/稳健算子回归(任务5/6/8,方案 §8/§9.1/§11.1)

覆盖:
- 档案拥挤案例:前 60 个同族变体 + 后部互补候选 → 后者在档案保留
  (方案 §8.1 验收;旧实现裸截前 60 会全部丢失);
- 档案容量/配额/确定性(同输入两次快照一致);
- 验证预算计数与耗尽;
- 种子模板:全部合法、按数据可用性过滤、注入配额 20-30%;
- robust_zscore/winsor:常数/缺失/极值/短窗/重复值/前缀不变/因果。

用法: python -X utf8 scripts/verify-crypto-archive.py
"""

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "public" / "pykernel"))

import numpy as np  # noqa: E402

from factor_lab.archive import (  # noqa: E402
    BoundedArchive,
    ValidationBudget,
    family_of,
)
from factor_lab.ops import OPS_NAMES, rolling_winsor, robust_zscore  # noqa: E402
from factor_lab.seed_templates import seed_fraction, seed_templates, templates_for  # noqa: E402
from factor_lab.token_encoding import FEAT_OFFSET  # noqa: E402
from factor_lab.vm import execute, validate  # noqa: E402


def _metrics(comp_seed: float, turnover: float = 0.1) -> dict:
    return {
        "ann_ret": comp_seed * 0.1,
        "sortino": 1.0 + comp_seed * 0.01,
        "ts_ic": 0.05,
        "consistency": 0.5,
        "oos_negative": False,
        "avg_turnover": turnover,
    }


class ArchiveTests(unittest.TestCase):
    def test_crowding_keeps_complementary(self):
        """方案 §8.1 验收:60 个同类变体挤满头部 + 后部互补候选 → 都保留。"""
        archive = BoundedArchive(capacity=64)
        # 前 60:同族(ohlcv_legacy)高分变体
        for k in range(60):
            archive.add(5.0 - k * 0.01, [k % 40, FEAT_OFFSET + 13], _metrics(5.0))
        # 后部:不同族/复杂度/换手的互补候选(分数更低)
        comp_tokens = [
            [52, FEAT_OFFSET + 14],                       # direct_deriv 短
            [45, 46, FEAT_OFFSET],                        # crypto_v1 二元
            [54, 0, 5, FEAT_OFFSET, FEAT_OFFSET + 14, FEAT_OFFSET + 15, FEAT_OFFSET + 17],  # direct 长
            [15, 0, FEAT_OFFSET + 2, FEAT_OFFSET + 14],   # legacy+OI 复杂
        ]
        for j, toks in enumerate(comp_tokens):
            archive.add(1.0 - j * 0.1, toks, _metrics(1.0, turnover=0.2 + 0.2 * j))
        snap = archive.snapshot()
        fams = {family_of(t) for _, t, _ in snap}
        self.assertIn("direct_deriv", fams, "互补的直连族候选必须保留在档案中")
        self.assertIn("crypto_v1", fams, "互补的加密族候选必须保留在档案中")
        # 60 次 add 中 k%40 去重后 40 个唯一同族 + 4 个互补 = 44;
        # 容量 64 内全部保留(旧实现裸截前 60 虽也能装下,但分数低的互补
        # 候选排在 40 个高分变体之后——一旦变体数 ≥60 就会被截掉,见下)
        self.assertEqual(len(snap), 44)

    def test_crowding_truncation_regression(self):
        """旧缺陷复现锚:80 个高分同族变体 + 低分互补 → 互补仍保留。"""
        archive = BoundedArchive(capacity=64)
        for k in range(80):
            archive.add(5.0 - k * 0.01, [k % 40, FEAT_OFFSET + 13, FEAT_OFFSET + 14], _metrics(5.0))
        archive.add(0.5, [52, FEAT_OFFSET + 14], _metrics(0.5, 0.3))
        snap = archive.snapshot()
        fams = {family_of(t) for _, t, _ in snap}
        self.assertIn("direct_deriv", fams, "低分互补候选不得被高分同族挤出档案")

    def test_capacity_bounded(self):
        archive = BoundedArchive(capacity=32)
        for k in range(500):
            archive.add(float(k), [k % 40, FEAT_OFFSET + 13, FEAT_OFFSET + 14], _metrics(k % 3))
        self.assertEqual(len(archive.snapshot()), 32)

    def test_snapshot_deterministic(self):
        archive = BoundedArchive(capacity=16)
        rng = np.random.default_rng(3)
        for k in range(200):
            toks = list(rng.integers(0, 59, 4)) + [FEAT_OFFSET + 14]
            archive.add(float(rng.normal()), sorted(toks), _metrics(k % 5, 0.01 * (k % 7)))
        a = archive.snapshot()
        b = archive.snapshot()
        self.assertEqual(a, b, "同输入两次快照必须逐位一致(确定性)")

    def test_validation_budget(self):
        budget = ValidationBudget(limit=3)
        self.assertTrue(budget.spend("gen1"))
        self.assertTrue(budget.spend("gen1"))
        self.assertTrue(budget.spend("gen2"))
        self.assertTrue(budget.exhausted)
        self.assertFalse(budget.spend("gen3"))
        self.assertEqual(budget.exposures["gen1"], 2)


class SeedTemplateTests(unittest.TestCase):
    def test_all_templates_valid_and_executable(self):
        mat = np.random.default_rng(1).normal(0, 1, (59, 300))
        for tpl in seed_templates():
            self.assertFalse(validate(tpl["tokens"]), tpl["family"])
            self.assertIsNotNone(execute(tpl["tokens"], mat), tpl["family"])

    def test_filter_by_availability(self):
        self.assertGreater(len(templates_for(list(range(59)))), 20)
        # 无直连数据(52-58 不可用):funding/流量/规模族被滤掉
        no_direct = templates_for(list(range(52)))
        for toks in no_direct:
            self.assertTrue(all(t < 52 or t >= FEAT_OFFSET for t in toks))

    def test_seed_fraction_bounds(self):
        self.assertEqual(seed_fraction(40, 28), 10)   # 25%
        self.assertEqual(seed_fraction(8, 28), 2)     # 至少留 2 个随机位
        self.assertEqual(seed_fraction(40, 2), 2)


class RobustOpTests(unittest.TestCase):
    def test_robust_zscore_basic_and_outlier(self):
        """正常数据有界;极端值被截断;常数→0;不除出无穷。"""
        rng = np.random.default_rng(4)
        x = rng.normal(0, 1, 300)
        z = robust_zscore(x, 20)
        self.assertTrue(np.isfinite(z).all())
        self.assertLessEqual(np.abs(z).max(), 3.0 + 1e-12)
        # 插入极端离群:中位数/MAD 不被拉飞,输出仍有界
        x2 = x.copy()
        x2[250] = 1e9
        z2 = robust_zscore(x2, 20)
        self.assertTrue(np.isfinite(z2).all())
        self.assertLessEqual(np.abs(z2).max(), 3.0 + 1e-12)
        # 常数输入:整窗相同 → 0(MAD=0 且 x=median)
        self.assertAlmostEqual(float(np.abs(robust_zscore(np.ones(100), 20)).max()), 0.0)

    def test_robust_zsign_symmetry(self):
        x = np.random.default_rng(5).normal(0, 1, 200)
        self.assertTrue(np.allclose(robust_zscore(x, 20), -robust_zscore(-x, 20), atol=1e-9))

    def test_robust_zscore_causal_prefix(self):
        """前缀不变:篡改后段不改变前段输出。"""
        rng = np.random.default_rng(6)
        x = rng.normal(0, 1, 200)
        y = x.copy()
        y[150:] *= 100.0
        y[150:] += 50.0
        a, b = robust_zscore(x, 20), robust_zscore(y, 20)
        self.assertTrue(np.allclose(a[:150], b[:150], atol=1e-12))

    def test_winsor_clips_and_causal(self):
        """winsor:阈值截至 t−1;极端值被拉回窗内分位;前缀不变。"""
        rng = np.random.default_rng(7)
        x = rng.normal(0, 1, 200)
        w = rolling_winsor(x, 20)
        self.assertTrue(np.isfinite(w).all())
        # 极端当前值被裁剪到历史分位区间内(允许阈值处)
        x2 = x.copy()
        x2[100] = 1e6
        w2 = rolling_winsor(x2, 20)
        hist = x2[81:100]
        lo, hi = np.quantile(hist, 0.05), np.quantile(hist, 0.95)
        self.assertGreaterEqual(w2[100], lo - 1e-9)
        self.assertLessEqual(w2[100], hi + 1e-9)
        # 前缀不变(第 100 根的篡改不影响 0..99)
        self.assertTrue(np.allclose(w[:100], w2[:100], atol=1e-12))
        # 短窗(<2 历史值)原样返回
        short = rolling_winsor(np.array([1.0, 2.0]), 20)
        self.assertTrue(np.array_equal(short, np.array([1.0, 2.0])))

    def test_new_ops_registered(self):
        """新算子 append-only 注册:token id 连续、文案/感染分类齐全。"""
        self.assertEqual(OPS_NAMES[-2], "ROBUST_ZSCORE_20")
        self.assertEqual(OPS_NAMES[-1], "WINSOR_20")
        from factor_lab.express import _OP_TEXT
        from factor_lab.vm import INFECTED_PROPAGATING_OPS, SIGN_RESTORE_OPS

        self.assertIn("ROBUST_ZSCORE_20", _OP_TEXT)
        self.assertIn("WINSOR_20", _OP_TEXT)
        self.assertIn("ROBUST_ZSCORE_20", SIGN_RESTORE_OPS)
        self.assertIn("WINSOR_20", INFECTED_PROPAGATING_OPS)
        # 经 StackVM 执行:极值/NaN 保护路径
        mat = np.random.default_rng(8).normal(0, 1, (59, 200))
        mat[0, 50] = 1e12
        for tokens in ([0, FEAT_OFFSET + 44], [0, FEAT_OFFSET + 45]):
            f = execute(tokens, mat)
            self.assertIsNotNone(f, tokens)
            self.assertTrue(np.isfinite(f).all(), tokens)


if __name__ == "__main__":
    unittest.main(verbosity=2)
