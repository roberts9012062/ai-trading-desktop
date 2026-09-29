"""GPU selection statistics against unchanged CPU research reports."""
import sys
import unittest
from pathlib import Path

import numpy as np
import taichi as ti

ROOT = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(ROOT / 'native-engine'), str(ROOT / 'public/pykernel')]
from engine.runtime import initialize_runtime
from factor_lab.search import _block_robustness
from factor_lab.scoring.deflated import deflated_sharpe
from factor_lab.scoring.regime import regime_masks
from factor_lab.scoring.evaluate import _sortino


class SelectionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        initialize_runtime('f64', require_cuda=True)

    def test_repeated_scalar_statistics_need_no_new_device_allocation(self):
        from unittest.mock import patch
        from engine.selection_ti import moments, pnl_stats
        from engine.series_ti import GpuSeries
        inputs = [np.sin(np.arange(n)/17)*.01 + drift for n, drift in ((513, .001), (2061, -.002))]
        resident = [GpuSeries.upload(x) for x in inputs]
        expected = [(moments(x), pnl_stats(x, 35040)) for x in resident]
        with patch('engine.selection_ti.ti.ndarray', side_effect=AssertionError('Repeated scalar output allocation')):
            for _ in range(2):
                for series, (stats, pnl) in zip(resident, expected):
                    self.assertEqual(moments(series), stats)
                    self.assertEqual(pnl_stats(series, 35040), pnl)
        for values, (stats, pnl) in zip(inputs, expected):
            np.testing.assert_allclose(stats, [values.mean(), values.std()], rtol=1e-12, atol=1e-15)
            self.assertAlmostEqual(pnl['sortino'], _sortino(values, 35040), delta=1e-10)

    def test_centered_correlation_matches_original_reductions_and_reuses_statistics(self):
        from unittest.mock import patch
        from engine.selection_ti import CenteredFactor, correlated_centered, correlated, moments
        from engine.series_ti import GpuSeries
        x = np.sin(np.arange(2061)/19)
        inputs = [GpuSeries.upload(v) for v in (x, -x, np.cos(np.arange(2061)/7),
                                                np.full(2061, 1.0), np.full(2061, 2.0))]
        centered = [CenteredFactor(series) for series in inputs]
        expected = {(i, j): correlated(a, b) for i, a in enumerate(inputs) for j, b in enumerate(inputs)}
        with patch('engine.selection_ti.moments', side_effect=AssertionError('Repeated centering statistics')):
            for (i, j), value in expected.items():
                self.assertEqual(correlated_centered(centered[i], centered[j]), value)
        from engine.selection_ti import program
        a, b = centered[0].centered, centered[2].centered
        product_mean = moments(a*b)[0]
        actual = program().dot_output
        program()._dot_mean(a.data, b.data, actual, 0)
        self.assertEqual(actual.to_numpy().tobytes(), np.array([product_mean], dtype=np.float64).tobytes())

    def test_correlation_bank_batches_the_original_pairwise_tree(self):
        from engine.selection_ti import CenteredFactor, CorrelationBank, correlated_centered, moments
        from engine.series_ti import GpuSeries
        inputs = [CenteredFactor(GpuSeries.upload(v)) for v in (
            np.sin(np.arange(2061)/19), -np.sin(np.arange(2061)/19), np.cos(np.arange(2061)/7))]
        bank = CorrelationBank(2061, 3)
        self.assertFalse(bank.any_correlated(inputs[0]))
        bank.append(inputs[0]); bank.append(inputs[2])
        for candidate in inputs:
            self.assertEqual(bank.any_correlated(candidate), any(correlated_centered(candidate, b) for b in (inputs[0], inputs[2])))
            expected = np.array([moments(candidate.centered*b.centered)[0] for b in (inputs[0], inputs[2])])
            self.assertEqual(bank.dots.to_numpy()[:2].tobytes(), expected.tobytes())
        bank.append(CenteredFactor(GpuSeries.full(2061, 1)))
        self.assertTrue(bank.any_correlated(inputs[2]))

    def test_resident_copy_correlation_and_constant_dedup(self):
        from engine.selection_ti import copy_factor, correlated, moments
        from engine.series_ti import GpuSeries
        x = np.sin(np.arange(2061)/19)
        matrix = ti.ndarray(ti.f64, shape=(2, len(x)))
        matrix.from_numpy(np.vstack((x, -x)))
        a, b = copy_factor(matrix, 0, 17, len(x)), copy_factor(matrix, 1, 17, len(x))
        self.assertEqual(a.to_numpy().tobytes(), x[17:].tobytes())
        self.assertTrue(correlated(a, b))
        self.assertFalse(correlated(a, GpuSeries.upload(np.cos(np.arange(a.T)/7))))
        self.assertTrue(correlated(GpuSeries.full(a.T, 1), GpuSeries.full(a.T, 2)))
        mean, sd = moments(a)
        self.assertAlmostEqual(mean, x[17:].mean(), delta=1e-13)
        self.assertAlmostEqual(sd, x[17:].std(), delta=1e-13)

    def test_continuous_pnl_block_robustness_and_dsr(self):
        from engine.selection_ti import block_robustness, dsr
        from engine.series_ti import GpuSeries
        from engine.metrics_ti import NumericalReports
        from factor_lab.scoring.evaluate import position_from_factor, next_ret
        n, cost, periods = 2061, .0003, 365*96
        factor = 2*np.sin(np.arange(n)/19)
        close = 100 + np.arange(n)*.01 + np.sin(np.arange(n)/13)
        matrix = ti.ndarray(ti.f64, shape=(1, n)); matrix.from_numpy(factor[None, :])
        reports = NumericalReports([{'close': x} for x in close], tile=1)
        actual = block_robustness(reports, matrix, cost, periods)
        expected = _block_robustness(factor, close, cost, periods)
        np.testing.assert_allclose(actual, expected, rtol=1e-10, atol=1e-10)
        pos = position_from_factor(factor)
        pnl = pos*next_ret(close) - np.abs(pos-np.concatenate(([0.0], pos[:-1])))*cost
        for trials in (1, 2, 300000):
            self.assertAlmostEqual(dsr(GpuSeries.upload(pnl), trials), deflated_sharpe(pnl, trials), delta=1e-10)
        self.assertIsNone(dsr(GpuSeries.full(30, 0), 10))
        self.assertIsNone(dsr(GpuSeries.full(29, 1), 10))

    def test_regime_partition_and_masked_statistics(self):
        from engine.selection_ti import regime_report
        from engine.series_ti import GpuSeries
        n, periods = 2061, 365*96
        close = 100 + np.sin(np.arange(n)/100)*5
        pnl = np.sin(np.arange(n)/11)*.003 + .0002
        actual = regime_report(GpuSeries.upload(close), GpuSeries.upload(pnl), periods)
        masks = regime_masks(close)
        for name, mask in masks.items():
            mask[0] = False; selected = pnl[mask]
            expected = {'bars': int(mask.sum()), 'sortino': round(_sortino(selected, periods), 3) if len(selected)>=30 else None,
                        'ann_ret': round(float(selected.mean()*periods), 4) if len(selected)>=30 else None}
            self.assertEqual(actual[name], expected)
        self.assertEqual(actual, regime_report(GpuSeries.upload(close), GpuSeries.upload(pnl), periods))

    def test_frozen_regime_masks_are_reused_without_recomputing_price_statistics(self):
        from unittest.mock import patch
        from engine.selection_ti import prepare_regime_masks, regime_report
        from engine.series_ti import GpuSeries
        close = 100+np.sin(np.arange(2061)/100)*5
        resident = GpuSeries.upload(close)
        masks = prepare_regime_masks(resident)
        expected_masks = regime_masks(close)
        for name, mask in masks.items():
            expected_masks[name][0] = False
            np.testing.assert_array_equal(mask.to_numpy().astype(bool), expected_masks[name])
        pnls = [GpuSeries.upload(np.sin(np.arange(2061)/period)*.003+.0002) for period in (11, 23)]
        expected = [regime_report(resident, pnl, 35040) for pnl in pnls]
        before = {name: mask.to_numpy().tobytes() for name, mask in masks.items()}
        with patch.object(GpuSeries, 'std', side_effect=AssertionError('Repeated price regime calculation')):
            for pnl, result in zip(pnls, expected):
                self.assertEqual(regime_report(resident, pnl, 35040, masks=masks), result)
        self.assertEqual(before, {name: mask.to_numpy().tobytes() for name, mask in masks.items()})
        with self.assertRaises(ValueError):
            regime_report(resident, pnls[0], 35040, masks={'chop': GpuSeries.full(17, 1)})


if __name__ == '__main__':
    unittest.main()
