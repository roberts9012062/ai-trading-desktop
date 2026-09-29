"""GPU feature primitives: IEEE materialization and missing-value propagation."""
import sys
import unittest
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "native-engine"))
from engine.runtime import initialize_runtime


class SeriesTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        initialize_runtime("f64", require_cuda=True)

    def test_gpu_array_arithmetic_and_ieee_division(self):
        from engine.series_ti import GpuSeries
        x = np.array([1e8 + .1, -2.0, 1.0 / 3, 7.0])
        y = np.array([3.0, 1e-8, 7.0, 9.0])
        a, b = GpuSeries.upload(x), GpuSeries.upload(y)
        self.assertEqual((a / b).to_numpy().tobytes(), (x / y).tobytes())
        self.assertEqual(((a + b) * 2.0 - a).to_numpy().tobytes(), ((x + y) * 2.0 - x).tobytes())

    def test_minimum_maximum_preserve_numpy_nan_semantics(self):
        from engine.series_ti import GpuSeries
        x = np.array([float("nan"), -float("inf"), float("inf"), -1.0, 2.0])
        a = GpuSeries.upload(x)
        np.testing.assert_array_equal(a.maximum(0.0).to_numpy(), np.maximum(x, 0.0))
        np.testing.assert_array_equal(a.minimum(0.0).to_numpy(), np.minimum(x, 0.0))

    def test_rolling_prefix_and_partial_windows_match_cpu_bytes(self):
        from engine.series_ti import GpuSeries
        x = 1e8 + np.sin(np.arange(4097) / 9)
        a = GpuSeries.upload(x)
        prefix = np.concatenate(([0.0], np.cumsum(x)))
        lo = np.maximum(0, np.arange(len(x)) - 19)
        expected = (prefix[1:] - prefix[lo]) / (np.arange(len(x)) - lo + 1)
        self.assertEqual(a.mean(20).to_numpy().tobytes(), expected.tobytes())

    def test_gpu_standard_deviation_and_masked_window_recovery(self):
        from engine.series_ti import GpuSeries
        sys.path.insert(0, str(ROOT / "public/pykernel"))
        from factor_lab.ops import ts_std
        from factor_lab.features import _masked_mean, _masked_zscore_causal
        x = np.sin(np.arange(513) / 9)
        self.assertEqual(GpuSeries.upload(x).std(20).to_numpy().tobytes(), ts_std(x, 20).tobytes())
        x[:17] = np.nan
        x[270:273] = np.nan
        a = GpuSeries.upload(x)
        np.testing.assert_allclose(a.mean(20, masked=True).to_numpy(), _masked_mean(x, 20),
                                   rtol=1e-12, atol=1e-12, equal_nan=True)
        np.testing.assert_allclose(a.zscore(200, masked=True).to_numpy(), _masked_zscore_causal(x, 200),
                                   rtol=1e-12, atol=1e-12, equal_nan=True)

    def test_lag_delta_return_and_bankers_clock_rounding(self):
        from engine.series_ti import GpuSeries
        x = np.array([1.0, 3.0, 2.0, 4.0, 5.0])
        a = GpuSeries.upload(x)
        np.testing.assert_array_equal(a.lag(1, first=True).to_numpy(), np.concatenate((x[:1], x[:-1])))
        np.testing.assert_array_equal(a.delta(1).to_numpy(), np.concatenate(([0.0], np.diff(x))))
        expected = np.concatenate(([0.0], np.diff(x) / np.maximum(np.abs(x[:-1]), 1e-9)))
        self.assertEqual(a.ret(1).to_numpy().tobytes(), expected.tobytes())
        values = np.array([1.25, 1.35, -1.25, -1.35, .05, -.05])
        self.assertEqual(GpuSeries.upload(values).round(1).to_numpy().tobytes(), np.round(values, 1).tobytes())

    def test_window_correlation_extrema_and_centered_moments(self):
        from engine.series_ti import GpuSeries
        sys.path.insert(0, str(ROOT / "public/pykernel"))
        from factor_lab.ops import ts_corr, ts_max, ts_min
        from factor_lab.features import _rolling_moment, _ac1
        x = np.sin(np.arange(513) / 9) + np.arange(513) * .001
        y = np.cos(np.arange(513) / 7)
        a, b = GpuSeries.upload(x), GpuSeries.upload(y)
        for actual, expected in ((a.corr(b, 20), ts_corr(x, y, 20)),
                                 (a.maximum_window(20), ts_max(x, 20)),
                                 (a.minimum_window(20), ts_min(x, 20)),
                                 (a.moment(20, 3), _rolling_moment(x, 20, 3)),
                                 (a.moment(20, 4), _rolling_moment(x, 20, 4))):
            np.testing.assert_allclose(actual.to_numpy(), expected, rtol=1e-12, atol=1e-12)
        close = 100 + x
        np.testing.assert_allclose(GpuSeries.upload(close).ret(1).autocorr(20).to_numpy(),
                                   _ac1(close, 20), rtol=1e-12, atol=1e-12)

    def test_path_order_forward_fill_streak_and_strength(self):
        from engine.series_ti import GpuSeries
        sys.path.insert(0, str(ROOT / "public/pykernel"))
        from factor_lab.features import _streak, strength_series
        from test_features import feature_bars
        raw = np.array([np.nan, 3.0, np.nan, np.nan, 4.0, np.nan])
        present = GpuSeries.upload(np.isfinite(raw).astype(float))
        np.testing.assert_array_equal(GpuSeries.upload(raw).forward_fill(present).to_numpy(),
                                      [0, 3, 3, 3, 4, 4])
        bars = feature_bars(513)
        close = np.array([b["close"] for b in bars])
        a = GpuSeries.upload(close)
        self.assertEqual(a.streak().to_numpy().tobytes(), _streak(close).tobytes())
        high = GpuSeries.upload([b["high"] for b in bars])
        low = GpuSeries.upload([b["low"] for b in bars])
        self.assertEqual(a.strength(high, low).to_numpy().tobytes(), strength_series(bars).tobytes())

    def test_any_finite_uses_gpu_reduction(self):
        from engine.series_ti import GpuSeries
        self.assertFalse(GpuSeries.upload([np.nan, np.inf, -np.inf]).any_finite())
        self.assertTrue(GpuSeries.upload([np.nan, 0.0, np.inf]).any_finite())


if __name__ == "__main__":
    unittest.main()
