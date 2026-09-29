"""Private coarse ranking may omit reports that never participate in ranking."""
import sys
import unittest
from pathlib import Path

import numpy as np
import taichi as ti

ROOT = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(ROOT/'native-engine'), str(ROOT/'public/pykernel')]
from engine.runtime import initialize_runtime
from engine.metrics_ti import TrainingMetrics, METRIC_NAMES


class RankingTests(unittest.TestCase):
    def test_f32_positions_are_private_deterministic_and_cannot_weaken_authority(self):
        initialize_runtime('mixed', require_cuda=True)
        values = np.linspace(-4, 4, 513)
        values[:6] = [-.05004172, .05004172, -0., 0., -30., 30.]
        factors = ti.ndarray(ti.f64, shape=(1, len(values)))
        factors.from_numpy(values[None, :])
        metrics = TrainingMetrics(100+np.sin(np.arange(len(values))/19), .0003, 35040, tile=1)
        authority = metrics.evaluate(factors, 1)
        authoritative_positions = metrics.positions.to_numpy().copy()
        with self.assertRaisesRegex(ValueError, 'private ranking'):
            metrics.evaluate(factors, 1, coarse_positions=True)
        ranked = metrics.evaluate(factors, 1, ranking_only=True, coarse_positions=True)
        actual = metrics.positions.to_numpy()
        expected = np.tanh(np.clip(values.astype(np.float32), -3, 3))
        expected[np.abs(expected)<np.float32(.05)] = 0
        np.testing.assert_allclose(actual[0], expected, rtol=2e-7, atol=2e-7)
        self.assertFalse(np.array_equal(actual, authoritative_positions))
        self.assertEqual(ranked.tobytes(), metrics.evaluate(factors, 1,
            ranking_only=True, coarse_positions=True).tobytes())
        self.assertEqual(authority.tobytes(), metrics.evaluate(factors, 1).tobytes())
        self.assertEqual(authoritative_positions.tobytes(), metrics.positions.to_numpy().tobytes())

    def test_frozen_return_cache_matches_cpu_rounding_and_terminal_calendar(self):
        from factor_lab.scoring.evaluate import _fwd_ret
        initialize_runtime('mixed', require_cuda=True)
        close = 100+np.sin(np.arange(37)/3)
        close[3:7] = [0.0, -0.0, -1e-12, 1e-12]
        metrics = TrainingMetrics(close, .0003, 35040, tile=1)
        actual = metrics.returns.to_numpy()
        self.assertEqual(actual[0].tobytes(), np.zeros(37).tobytes())
        for group, horizon in enumerate((1, 5, 20), 1):
            self.assertEqual(actual[group].tobytes(), _fwd_ret(close, horizon).tobytes())

    def test_private_ranking_preserves_every_consumed_value_and_authority(self):
        initialize_runtime('mixed', require_cuda=True)
        for size, head in ((513, 0), (1025, 17)):
            t = np.arange(size)
            factors = ti.ndarray(ti.f64, shape=(3, size))
            factors.from_numpy(np.vstack((np.sin(t/7), np.cos(t/13), np.full(size, .5))))
            metrics = TrainingMetrics(100+np.sin(t/19), .0003, 35040, tile=3, head_trim=head)
            authority = metrics.evaluate(factors, 3)
            ranked = metrics.evaluate(factors, 3, ranking_only=True)
            consumed = [i for i, name in enumerate(METRIC_NAMES) if name not in ('ts_ic_5', 'ts_ic_20')]
            self.assertEqual(authority[:, consumed].tobytes(), ranked[:, consumed].tobytes())
            self.assertEqual(ranked.tobytes(), metrics.evaluate(factors, 3, ranking_only=True).tobytes())
            self.assertEqual(authority.tobytes(), metrics.evaluate(factors, 3).tobytes())
            self.assertTrue(np.isfinite(ranked).all())
            self.assertTrue(np.all(ranked[:, [4, 5]] == 0))


if __name__ == '__main__':
    unittest.main()
