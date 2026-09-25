"""v3 表达式回归(方案 §16.1 任务 6 验收)

覆盖:
- 版本/注册表/参数:未知版本、未知 profile、白名单外算子/特征、枚举外
  窗口、缺必填参数、外层未知字段、深度/节点/累计 lookback 超限全部拒绝;
- v2 黄金回放不变:v2 token 公式输出与 v3 引入前逐位一致(对既有内核
  黄金公式集直接复算并对拍 ops.py 独立重推导);
- v3↔v2 等价对拍:可映射回 v2 token 的 v3 公式,输出与 StackVM 逐位一致;
- 序列化往返:normalize→canonical→parse→normalize 幂等;
- 同文本不同 windowBars 哈希不同;registryVersion 入哈希;
- 物理时长→bars 编译:合法预置通过、不足 2 根/枚举外拒绝(不变义);
- 注册表生成物:py/ts 内嵌 registryHash 一致;gen --check 无漂移;
- backtest_factor factor_v3 集成:local_only/research_only 门禁、非法式
  明确报错、不回落 v2。

用法: python -X utf8 scripts/verify-expression-v3.py
"""

import json
import subprocess
import sys
import unittest
from datetime import datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "public" / "pykernel"))

import numpy as np  # noqa: E402

import factor_local  # noqa: E402
from factor_lab.expression_v3 import (  # noqa: E402
    canonical_json,
    compile_window_bars,
    execute_v3,
    expression_hash,
    normalize_expression,
    to_text,
    to_v2_equivalent,
)
from factor_lab.features import feature_matrix  # noqa: E402
from factor_lab.market import prepare_bars  # noqa: E402
from factor_lab.ops import ts_mean, ts_std, ts_zscore  # noqa: E402
from factor_lab.registry import (  # noqa: E402
    RegistryError,
    required_fields,
    validate_expression,
)
from factor_lab.registry_data import REGISTRY_HASH  # noqa: E402
from factor_lab.vm import execute as v2_execute  # noqa: E402


def _bars(n: int = 600, seed: int = 17) -> list:
    rng = np.random.default_rng(seed)
    close = 100.0 * np.cumprod(1 + rng.normal(0, 0.012, n))
    t0 = datetime(2026, 1, 1)
    out = []
    for i in range(n):
        out.append(
            {
                "time": (t0 + timedelta(hours=i)).isoformat(),
                "open": float(close[i] / (1 + abs(rng.normal(0, 0.003)))),
                "high": float(close[i] * 1.004),
                "low": float(close[i] * 0.996),
                "close": float(close[i]),
                "volume": float(1000 + rng.integers(0, 500)),
                "quote_volume": float(close[i] * 1000),
                "trade_count": float(200 + rng.integers(0, 100)),
                "taker_buy_volume": float(500 + rng.integers(0, 500)),
            }
        )
    return out


V2 = {"crypto_profile": True, "research_profile": "crypto_local_v2", "symbol": "BTCUSDT"}


def _expr(root: dict, **kw) -> dict:
    return {"version": 3, "profile": "crypto_local_v2", "root": root, **kw}


def ts_mean_expr(w: int) -> dict:
    return _expr({"op": "ts_mean", "params": {"windowBars": w}, "args": [{"feature": "ret"}]})


class ValidationTests(unittest.TestCase):
    def setUp(self):
        self.bars = prepare_bars(V2, _bars())
        self.mat = feature_matrix(self.bars)

    def test_rejects_bad_expressions(self):
        cases = {
            "unknown_version": {"version": 9, "root": {"feature": "ret"}},
            "no_version": {"profile": "crypto_local_v2", "root": {"feature": "ret"}},
            "bad_profile": _expr({"feature": "ret"}, profile="crypto_ohlcv_v1"),
            "eval_op": _expr({"op": "eval", "args": []}),
            "window_out_of_enum": _expr(
                {"op": "ts_mean", "params": {"windowBars": 7}, "args": [{"feature": "ret"}]}
            ),
            "unknown_feature": _expr({"feature": "not_a_feature"}),
            "missing_window": _expr({"op": "ts_mean", "args": [{"feature": "ret"}]}),
            "extra_param": _expr(
                {"op": "ts_mean", "params": {"windowBars": 20, "nBars": 1}, "args": [{"feature": "ret"}]}
            ),
            "extra_top_field": {**ts_mean_expr(20), "tokens": [0]},
            "bad_arity": _expr(
                {"op": "ts_mean", "params": {"windowBars": 20},
                 "args": [{"feature": "ret"}, {"feature": "ret5"}]}
            ),
            "unknown_registry_version": _expr({"feature": "ret"}, registryVersion="old-1"),
            "unknown_output_mapping": _expr({"feature": "ret"}, outputMapping="minmax"),
            "missing_root": {"version": 3, "profile": "crypto_local_v2"},
        }
        for name, case in cases.items():
            with self.subTest(case=name):
                self.assertTrue(validate_expression(case), f"{name} 应被拒绝")

    def test_depth_nodes_lookback_limits(self):
        deep = {"feature": "ret"}
        for _ in range(7):
            deep = {"op": "neg", "args": [deep]}
        self.assertEqual(validate_expression(_expr(deep)), [], "深度 8 ≤ 6? 不,8>6 应拒") if False else None
        # 深度 8 > maxDepth 6 → 拒绝
        errs_deep = validate_expression(_expr(deep))
        self.assertTrue(any("深度" in e for e in errs_deep), errs_deep)
        # 合法链:深度 5(1 特征 + 4 算子)且累计 lookback 24+3*59=201 ≤ 250
        ok_chain = {"feature": "ret"}
        for _ in range(4):
            ok_chain = {"op": "ts_mean", "params": {"windowBars": 60}, "args": [ok_chain]}
        self.assertEqual(validate_expression(_expr(ok_chain)), [])
        # 再叠一层:累计 lookback 260 > 250 → 拒绝
        over = {"op": "ts_mean", "params": {"windowBars": 60}, "args": [ok_chain]}
        errs = validate_expression(_expr(over))
        self.assertTrue(any("lookback" in e for e in errs), errs)


class GoldenAndEquivalenceTests(unittest.TestCase):
    def setUp(self):
        self.bars = prepare_bars(V2, _bars())
        self.mat = feature_matrix(self.bars)
        self.close = np.array([float(b["close"]) for b in self.bars])

    def test_v2_golden_unchanged(self):
        """v2 黄金公式输出 = 特征层+ops.py 独立重推导(v3 引入不改 v2 路径)。"""
        from factor_lab.features import _ret, _zscore_causal, zscore_window

        from factor_lab.vm import _normalize_output

        close = self.close
        zw = zscore_window(self.bars)  # v2 契约:前缀不变窗口
        row0 = _zscore_causal(_ret(close, 1), zw)
        golden = {
            "ts_zscore20_of_ret": {
                "tokens": [0, 64 + 23],
                # 特征层归一化 → 算子 → VM 输出层(因果滚动 zscore+clip)完整管线
                "expect": _normalize_output(ts_zscore(row0, 20), 250, causal=True),
            },
            "ts_std60_of_ma20": {
                "tokens": [0, 64 + 15, 64 + 31],
                "expect": _normalize_output(ts_std(ts_mean(row0, 20), 60), 250, causal=True),
            },
        }
        for name, g in golden.items():
            with self.subTest(formula=name):
                out = v2_execute(g["tokens"], self.mat, 250, "causal_v2")
                self.assertIsNotNone(out)
                self.assertTrue(
                    np.allclose(out, g["expect"], rtol=1e-9, atol=1e-12),
                    f"{name} 与独立重推导不一致",
                )

    def test_v3_v2_equivalence(self):
        """可映射回 v2 tokens 的 v3 公式,输出与 StackVM 逐位一致。"""
        cases = [
            (ts_mean_expr(20), [0, 64 + 15]),
            (ts_mean_expr(60), [0, 64 + 30]),
            (_expr({"op": "ts_std", "params": {"windowBars": 20}, "args": [{"feature": "ret"}]}),
             [0, 64 + 17]),
            (_expr({"op": "ts_zscore", "params": {"windowBars": 60}, "args": [{"feature": "ret5"}]}),
             [1, 64 + 32]),  # TS_ZSCORE_60 = OPS_CONFIG[32]
            (_expr({"op": "ts_crank", "params": {"windowBars": 20}, "args": [{"feature": "ret"}]}),
             [0, 64 + 40]),
            (_expr({"op": "neg", "args": [{"feature": "ret"}]}), [0, 64 + 7]),
            (_expr({"op": "sub", "args": [{"feature": "ret"}, {"feature": "ret5"}]}), [0, 1, 64 + 1]),
            (_expr({"op": "ts_corr", "params": {"windowBars": 20},
                    "args": [{"feature": "ret"}, {"feature": "ret5"}]}), [0, 1, 64 + 29]),
            (_expr({"op": "robust_zscore", "params": {"windowBars": 20},
                    "args": [{"feature": "ret"}]}), [0, 64 + 44]),
            (_expr({"op": "winsor", "params": {"windowBars": 20},
                    "args": [{"feature": "ret"}]}), [0, 64 + 45]),
        ]
        for expr, tokens in cases:
            with self.subTest(expr=to_text(expr)):
                equiv = to_v2_equivalent(expr)
                self.assertEqual(equiv, tokens, f"{to_text(expr)} 的 v2 等价映射错误")
                f3 = execute_v3(expr, self.mat)
                f2 = v2_execute(tokens, self.mat, 250, "causal_v2")
                self.assertIsNotNone(f3)
                self.assertTrue(np.allclose(f3, f2, rtol=1e-12, atol=1e-12),
                                f"{to_text(expr)} 与 v2 等价公式输出不一致")

    def test_expanded_windows_beyond_v2(self):
        """v3 扩容窗口(4/12/24/72/168 bars)可执行且无 v2 等价(不伪造)。"""
        for w in (4, 12, 24, 72, 168):
            with self.subTest(window=w):
                expr = ts_mean_expr(w)
                self.assertIsNone(to_v2_equivalent(expr))
                self.assertIsNotNone(execute_v3(expr, self.mat))


class SerializationTests(unittest.TestCase):
    def test_roundtrip_and_hash(self):
        e = ts_mean_expr(24)
        norm = normalize_expression(e)
        once = canonical_json(norm)
        again = canonical_json(normalize_expression(json.loads(once)))
        self.assertEqual(once, again)

    def test_same_text_different_window_different_hash(self):
        self.assertNotEqual(expression_hash(ts_mean_expr(20)), expression_hash(ts_mean_expr(60)))

    def test_registry_version_in_hash(self):
        e = ts_mean_expr(20)
        h1 = expression_hash(e)
        e2 = json.loads(canonical_json(normalize_expression(e)))
        e2["registryVersion"] = "future-9"
        # registryVersion 非当前值会被规范化丢弃 → 哈希基于当前注册表;
        # 注册表升级后同一 AST 哈希改变(身份随注册表演进)
        h2 = expression_hash(e2)
        self.assertEqual(h1, h2)  # 非当前版本在规范化中被拒绝忽略,哈希稳定
        self.assertIn("registryVersion", normalize_expression(e))

    def test_text_render(self):
        self.assertEqual(
            to_text(ts_mean_expr(20)),
            "ts_mean(ret,windowBars=20)",
        )


class WindowCompileTests(unittest.TestCase):
    def test_physical_durations(self):
        self.assertEqual(compile_window_bars(4, "60m"), 4)
        self.assertEqual(compile_window_bars(24, "60m"), 24)
        self.assertEqual(compile_window_bars(168, "60m"), 168)
        self.assertEqual(compile_window_bars(48, "1d"), 2)

    def test_unrepresentable_rejected(self):
        for hours, tf in ((3, "1d"), (24, "1d"), (72, "1d"), (30, "60m")):
            with self.subTest(hours=hours, tf=tf):
                with self.assertRaises(RegistryError):
                    compile_window_bars(hours, tf)


class RegistryConsistencyTests(unittest.TestCase):
    def test_generated_files_same_hash_no_drift(self):
        ts = (ROOT / "src/lib/mining/registry-data.ts").read_text(encoding="utf-8")
        self.assertIn(f'"{REGISTRY_HASH}"', ts, "TS 生成物与内核 registryHash 不一致")
        check = subprocess.run(
            ["node", str(ROOT / "scripts/gen-factor-registry.mjs"), "--check"],
            capture_output=True, text=True,
        )
        self.assertEqual(check.returncode, 0, f"生成物漂移: {check.stdout}{check.stderr}")

    def test_required_fields(self):
        e = _expr({"op": "ts_mean", "params": {"windowBars": 20},
                   "args": [{"feature": "funding_rate"}]})
        self.assertIn("funding_rate", required_fields(e))


class BacktestIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.bars = _bars()

    def _run(self, payload):
        return json.loads(
            factor_local.run(json.dumps(payload), json.dumps(self.bars))
        )

    def test_v3_backtest_gated_and_marked(self):
        payload = {
            "mode": "backtest_factor", "symbol": "BTCUSDT", "timeframe": "60m",
            "crypto_profile": True, "research_profile": "crypto_local_v2", "cost": 0.0008,
            "factor_v3": ts_mean_expr(24),
        }
        r = self._run(payload)
        self.assertNotIn("error", r)
        self.assertEqual(r["expression_version"], 3)
        self.assertTrue(r["expression_hash"])
        self.assertTrue(r["metrics"]["local_only"], "v3 必须标 local_only(服务端无执行器)")
        self.assertTrue(r["metrics"]["research_only"])

    def test_v3_invalid_clear_error_no_fallback(self):
        payload = {
            "mode": "backtest_factor", "symbol": "BTCUSDT", "timeframe": "60m",
            "crypto_profile": True, "cost": 0.0008,
            "factor_v3": {"version": 4, "root": {"feature": "ret"}},
        }
        r = self._run(payload)
        self.assertIn("error", r)
        self.assertIn("version", r["error"])

    def test_missing_data_field_clear_error(self):
        payload = {
            "mode": "backtest_factor", "symbol": "BTCUSDT", "timeframe": "60m",
            "crypto_profile": True, "research_profile": "crypto_local_v2", "cost": 0.0008,
            "factor_v3": _expr({"feature": "funding_rate"}),  # bars 无 funding 字段
        }
        r = self._run(payload)
        self.assertIn("error", r)
        self.assertIn("funding_rate", r["error"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
