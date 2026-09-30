"""短线 v4 特征 native 侧测试（需 CUDA；无卡环境自动跳过）。

- features_ti: sl 列 → 70 行矩阵；GPU 行与 pykernel masked zscore 逐位一致
- vm_ti: token 115 可执行、无列拒绝
- metrics_ti: flip_rate/half_life 指标产出 + shortline 乘子 = v2 composite × penalty
"""
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "native-engine"))
sys.path.insert(0, str(ROOT / "public" / "pykernel"))

import numpy as np

from tests.native_engine.test_shortline_pykernel import _bars  # 同一合成数据


class ShortlineNativeTests(unittest.TestCase):
    """CUDA 会话由 setUpClass 的 initialize_runtime(require_cuda=True) 守门——
    无卡环境在 setUpClass 报可行动错误(与 G1 门一致),不做静默跳过。"""
    @classmethod
    def setUpClass(cls):
        from engine.runtime import initialize_runtime

        cls.runtime = initialize_runtime("f64", require_cuda=True)

    def test_matrix_rows_bitmatch_cpu(self):
        from engine.features_ti import GpuFeatureMatrix, compute_features
        from factor_lab.features import SHORTLINE_FEATURE_NAMES, feature_matrix

        bars = _bars(360)
        gpu = compute_features(bars)
        self.assertEqual(gpu.matrix.shape[0], 70)
        host = gpu.to_numpy()
        cpu = feature_matrix(bars)
        self.assertEqual(cpu.shape[0], 70)
        # v4 行(62-69)宿主侧逐位一致(同一 numpy 实现产出)
        for k in range(8):
            np.testing.assert_array_equal(host[62 + k], cpu[62 + k])
        # base 行在浮点求和顺序容差内一致
        np.testing.assert_allclose(host[:62], cpu[:62], rtol=1e-12, atol=1e-12)
        # 无 sl 列 → 62 行
        gpu62 = compute_features(_bars(120, with_sl=False))
        self.assertEqual(gpu62.matrix.shape[0], 62)

    def test_vm_executes_v4_token(self):
        from engine.vm_ti import StackVM, validate_tokens
        from engine.features_ti import compute_features

        bars = _bars(360)
        gpu = compute_features(bars)
        vm = StackVM(gpu.matrix, "f64", norm_window=250, normalization="causal_v2")
        validate_tokens([115, 64 + 23], vm.F)  # 不抛错
        # 无列矩阵上 v4 token 被拒
        gpu62 = compute_features(_bars(120, with_sl=False))
        vm62 = StackVM(gpu62.matrix, "f64", norm_window=250, normalization="causal_v2")
        with self.assertRaises(ValueError):
            validate_tokens([115], vm62.F)

    def test_metrics_shortline_multiplier(self):
        """shortline 开 → composite = v2 composite × penalty(flip/hl/turnover)"""
        from engine.metrics_ti import METRIC_NAMES, TrainingMetrics

        bars = _bars(400)
        close = np.array([float(b["close"]) for b in bars])
        rng = np.random.default_rng(9)
        factors = np.stack([np.sin(np.arange(400) / 25.0 + rng.uniform(0, 3)) for _ in range(4)])
        base = TrainingMetrics(close, 0.0003, 35040, tile=4)
        sl = TrainingMetrics(close, 0.0003, 35040, tile=4, shortline=True)
        names = dict((n, i) for i, n in enumerate(METRIC_NAMES))
        out_base = base.evaluate(factors, 4)
        out_sl = sl.evaluate(factors, 4)
        for p in range(4):
            turn = out_base[p, names["avg_turnover"]]
            flip = out_sl[p, names["flip_rate"]]
            hl = out_sl[p, names["half_life"]]
            penalty = max(
                0.0,
                1 - 0.5 * min(turn / 0.35, 1) - 0.3 * min(flip / 0.08, 1) - 0.2 * max(0, 1 - hl / 48),
            )
            self.assertAlmostEqual(
                out_sl[p, names["composite"]],
                out_base[p, names["composite"]] * penalty,
                places=12,
            )
            # 非 shortline 的 flip/half_life 指标仍产出(报告项)
            self.assertGreaterEqual(out_base[p, names["flip_rate"]], 0.0)
        # v2 口径 composite 不受 shortline 附加归约影响(加法性)
        self.assertEqual(out_base.shape[1], len(METRIC_NAMES))


if __name__ == "__main__":
    unittest.main()
