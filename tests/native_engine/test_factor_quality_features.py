"""New TA features must preserve old IDs and agree across execution paths."""
import sys
import unittest
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "public" / "pykernel"))
from tests.native_engine.test_shortline_pykernel import _bars


class FactorQualityTests(unittest.TestCase):
    def test_candidate_admission_does_not_dilute_default_search(self):
        from factor_lab.feature_policy import search_feature_pool
        self.assertEqual(search_feature_pool([1, 62, 63]), [1])
        self.assertEqual(search_feature_pool([1, 62, 63], [62, 63]), [62, 63])
        self.assertEqual(search_feature_pool([1, 62, 63], seeds=[[62, 78]]), [1, 62])

    def test_shortline_matrix_metadata_keeps_all_rows_addressable(self):
        import json
        from factor_local import run_mine_features
        result = json.loads(run_mine_features({"symbol": "ETHUSDT", "research_profile": "shortline_v1", "crypto_profile": True, "timeframe": "1m"}, _bars(800)))
        self.assertEqual(len(result["feature_names"]), 72)
        self.assertEqual(len(result["matrix"]), 72)
        self.assertTrue({62, 63}.isdisjoint(result["active_feature_ids"]))

    def test_seed_ids_follow_the_feature_registry(self):
        from factor_lab.features import FEATURE_NAMES
        from factor_lab.seed_templates import F
        for name, feature_id in F.items():
            self.assertEqual(FEATURE_NAMES[feature_id], name, name)

    def test_registry_covers_runtime_and_new_ast_operators(self):
        from factor_lab.features import FEATURE_NAMES, feature_matrix
        from factor_lab.registry import FEATURE_BY_NAME
        from factor_lab.registry_data import REGISTRY_VERSION
        from factor_lab.expression_v3 import execute_v3, to_v2_equivalent
        from factor_lab.vm import execute
        matrix = feature_matrix(_bars(600, with_sl=False))
        self.assertEqual(set(FEATURE_BY_NAME), {name.lower() for name in FEATURE_NAMES})
        for name, op, window in (("macd_hist", "ts_mean", 10), ("kdj_j", "snr", 20), ("ret", "vol_scale", 20)):
            expr = {"version": 3, "profile": "crypto_local_v2", "registryVersion": REGISTRY_VERSION,
                    "root": {"op": op, "params": {"windowBars": window}, "args": [{"feature": name}]}}
            tokens = to_v2_equivalent(expr)
            self.assertIsNotNone(tokens)
            result = execute_v3(expr, matrix)
            self.assertIsNotNone(result)
            self.assertGreater(float(np.std(result[300:])), .01)
            np.testing.assert_allclose(result[300:], execute(tokens, matrix, normalization="causal_v2")[300:], atol=1e-9)
        broken = matrix.copy()
        broken[63, 400] = np.nan
        expr["root"] = {"feature": "kdj_j"}
        self.assertIsNone(execute_v3(expr, broken))

    def test_append_only_and_server_remapping(self):
        from factor_lab.features import FEATURE_NAMES, feature_matrix
        from crypto_factor_kernel.features.compute import FEATURE_NAMES as SERVER_NAMES
        from crypto_factor_kernel.token_encoding import remap_desktop_to_v3
        from crypto_factor_kernel.selected_features import feature_matrix as server_matrix
        from factor_lab.market import prepare_bars
        from factor_lab.vm import execute
        from crypto_factor_kernel.vm import execute as server_execute
        self.assertEqual(FEATURE_NAMES[62:], ("MACD_HIST", "KDJ_J"))
        self.assertEqual(SERVER_NAMES[83:], ("MACD_HIST", "KDJ_J"))
        bars = prepare_bars({"research_profile": "crypto_local_v2", "symbol": "ETHUSDT"}, _bars(500, with_sl=False))
        for feature_id in (62, 63):
            tokens = [feature_id, 64 + 14]
            mapped = remap_desktop_to_v3(tokens)
            self.assertEqual(mapped, [feature_id + 21, 128 + 14])
            local = execute(tokens, feature_matrix(bars), normalization="causal_v2")
            remote = server_execute(mapped, server_matrix(bars, mapped))
            self.assertGreater(float(np.std(local[250:])), .1)
            np.testing.assert_allclose(local[250:], remote[250:], rtol=1e-9, atol=1e-9)
            leaf = remap_desktop_to_v3([feature_id])
            self.assertEqual(leaf, [feature_id + 21, 135, 135])
            self.assertEqual(remap_desktop_to_v3(leaf), leaf)
            np.testing.assert_allclose(execute([feature_id], feature_matrix(bars), normalization="causal_v2")[250:],
                                       server_execute(leaf, server_matrix(bars, leaf))[250:], atol=1e-9)

    def test_technical_features_are_prefix_causal_and_scale_invariant(self):
        from factor_lab.technical_features import technical_features
        bars = _bars(500, with_sl=False)
        scaled = [{**b, **{key: b[key] * 17 for key in ("open", "high", "low", "close")}} for b in bars]
        full, prefix, other = technical_features(bars), technical_features(bars[:350]), technical_features(scaled)
        self.assertEqual(set(full), {"MACD_HIST", "KDJ_J"})
        for name in full:
            np.testing.assert_allclose(full[name][:350], prefix[name], equal_nan=True, atol=1e-10)
            np.testing.assert_allclose(full[name], other[name], equal_nan=True, atol=1e-9)
            self.assertTrue(np.isfinite(full[name][250:]).all())

    def test_missing_warmup_is_not_a_fake_zero_signal(self):
        from factor_lab.technical_features import technical_features
        from factor_lab.features import active_feature_ids, feature_matrix
        rows = technical_features(_bars(20, with_sl=False))
        self.assertTrue(np.isnan(rows["MACD_HIST"]).all())
        self.assertTrue(np.isnan(rows["KDJ_J"][:8]).all())
        matrix = feature_matrix(_bars(500, with_sl=False))
        self.assertTrue({62, 63} <= set(active_feature_ids(matrix, crypto_profile=True, max_head_gap=250)))

    def test_old_62_rows_are_unchanged(self):
        import subprocess
        from factor_lab.features import compute_features
        try:
            source = subprocess.check_output(["git", "show", "f2b3f7f:public/pykernel/factor_lab/features.py"], cwd=ROOT, stderr=subprocess.DEVNULL).decode("utf8")
        except subprocess.CalledProcessError:
            self.skipTest("Frozen baseline commit is unavailable in this shallow checkout")
        namespace = {"__package__": "factor_lab", "__name__": "factor_lab.frozen_baseline"}
        exec(compile(source, "frozen_baseline", "exec"), namespace)
        bars = _bars(500, with_sl=False)
        old, new = namespace["compute_features"](bars), compute_features(bars)
        for name in namespace["FEATURE_NAMES"]:
            np.testing.assert_array_equal(old[name], new[name], err_msg=name)


if __name__ == "__main__":
    unittest.main()
