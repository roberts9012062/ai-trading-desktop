"""M2 feature oracle checks, including masks and causal prefix behavior."""
import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

import numpy as np
import taichi as ti

ROOT = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(ROOT / "native-engine"), str(ROOT / "public/pykernel")]
from engine.runtime import initialize_runtime
from factor_lab.features import FEATURE_NAMES, feature_matrix
from factor_lab.market import prepare_bars


def feature_bars(count=513, *, missing=False):
    start = datetime(2025, 1, 2, 21, tzinfo=timezone.utc)
    bars = []
    for i in range(count):
        close = 100 + .015 * i + np.sin(i / 11)
        volume = 1000 + (i % 19) * 23
        bar = {"time": (start + timedelta(minutes=15 * i)).isoformat(),
               "open": close - .2 * np.cos(i / 7), "high": close + 1,
               "low": close - 1, "close": close, "volume": volume,
               "open_interest": 20000 + i * 2 + np.sin(i / 31) * 50,
               "quote_volume": volume * close, "taker_buy_volume": volume * (.5 + .2 * np.sin(i / 13)),
               "trade_count": 20 + i % 37, "funding_rate": .0001 * np.sin(i / 59),
               "long_short_ratio": 1 + .1 * np.cos(i / 17),
               "liquidation_imbalance": .3 * np.sin(i / 23)}
        if missing:
            if i < 17 or 270 <= i < 273:
                bar["funding_rate"] = None
            if i % 31 == 0:
                bar["open_interest"] = None
            if i % 53 == 0:
                bar["quote_volume"] = None
        bars.append(bar)
    return bars


class FeatureTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        initialize_runtime("f64", require_cuda=True)

    def assert_features(self, bars):
        from engine.features_ti import compute_features
        expected = feature_matrix(bars)
        # GPU implementation may read constants and metadata helpers, but must
        # never call the CPU numerical feature oracle in production.
        with patch("factor_lab.features.compute_features", side_effect=AssertionError("CPU feature execution")):
            resident = compute_features(bars)
        self.assertEqual(resident.matrix.dtype, ti.f64)
        actual = resident.to_numpy()
        self.assertEqual(actual.shape, (len(FEATURE_NAMES), len(bars)))
        self.assertEqual(np.isfinite(actual).tobytes(), np.isfinite(expected).tobytes())
        for f, name in enumerate(FEATURE_NAMES):
            np.testing.assert_allclose(actual[f], expected[f], rtol=1e-9, atol=1e-9,
                                       equal_nan=True, err_msg=name)
        self.assertEqual(actual.tobytes(), compute_features(bars).to_numpy().tobytes())
        return actual

    def test_all_62_legacy_feature_rows(self):
        self.assert_features(prepare_bars({"crypto_profile": True, "symbol": "ETHUSDT"}, feature_bars()))

    def test_real_desktop_moments_preserve_zero_before_sign(self):
        import json, hashlib
        from engine.features_ti import compute_features
        from engine.vm_ti import StackVM
        fixture = json.loads((Path(__file__).parent/'fixtures/moment-sign-pyodide.json').read_text())
        self.assertEqual(fixture['wasm_sha256'], hashlib.sha256((ROOT/'public/pyodide/pyodide.asm.wasm').read_bytes()).hexdigest())
        bars = prepare_bars({'crypto_profile': True, 'symbol': 'ETHUSDT'}, fixture['bars'])
        resident = compute_features(bars)
        matrix = resident.to_numpy()
        for name, bits in fixture['feature_bits'].items():
            expected = np.array([int(x) for x in bits], dtype=np.uint64)
            np.testing.assert_array_equal(matrix[int(name)].view(np.uint64), expected, err_msg=name)
        factor = StackVM(resident.matrix, 'f64', tile=1, normalization='legacy').execute_batch([fixture['tokens']])[0]
        expected = np.array([int(x) for x in fixture['factor_bits']], dtype=np.uint64).view(np.float64)
        np.testing.assert_allclose(factor, expected, rtol=1e-12, atol=1e-12)

    def test_v2_missing_data_mask_and_forward_fill(self):
        bars = prepare_bars({"research_profile": "crypto_local_v2", "symbol": "ETHUSDT"}, feature_bars(missing=True))
        self.assert_features(bars)

    def test_v2_prefix_is_bitwise_unchanged_when_future_bars_are_appended(self):
        from engine.features_ti import compute_features
        bars = prepare_bars({"research_profile": "crypto_local_v2", "symbol": "ETHUSDT"}, feature_bars(missing=True))
        whole = compute_features(bars).to_numpy()
        prefix = compute_features(bars[:300]).to_numpy()
        self.assertEqual(whole[:, :300].tobytes(), prefix.tobytes())

    def test_gpu_availability_head_trim_and_resident_prefix(self):
        from engine.features_ti import compute_features
        from factor_lab.features import active_feature_ids
        from factor_lab.search import _v2_head_trim
        bars = prepare_bars({"research_profile": "crypto_local_v2", "symbol": "ETHUSDT"}, feature_bars(missing=True))
        resident = compute_features(bars)
        expected = feature_matrix(bars)[:, :400]
        active = active_feature_ids(expected, True, max_head_gap=250)
        actual = resident.availability(400, crypto=True, max_head_gap=250)
        self.assertEqual(actual["active_feature_ids"], active)
        self.assertEqual(actual["head_trim"], _v2_head_trim(expected, active))
        self.assertEqual(actual["finite_features"], np.isfinite(expected).all(axis=1).tolist())
        self.assertEqual(resident.prefix(400).to_numpy().tobytes(), resident.to_numpy()[:, :400].tobytes())


if __name__ == "__main__":
    unittest.main()
