"""Factor prefetch must not change scalar dedup/cache admission order."""
import sys
import unittest
from collections import OrderedDict
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(ROOT/'native-engine'), str(ROOT/'public/pykernel')]
from engine.precise_ti import GpuDedup
from engine.wf_ti import _SEG_RESULTS


class FactorPrefetchTests(unittest.TestCase):
    def test_snapshots_do_not_insert_or_move_caches_until_scalar_factor_access(self):
        dedup = GpuDedup.__new__(GpuDedup)
        dedup.train = [{'_factor_market': 'crypto_ohlcv_v1'}]*10
        dedup.trim = 2
        existing = SimpleNamespace(T=8)
        dedup.series = OrderedDict([((0,), existing)])
        dedup.prefetched_factors = {}
        data = {'bars': dedup.train, 'features': SimpleNamespace(matrix=SimpleNamespace(shape=(2, 10))),
                'vm': SimpleNamespace(norm_window=250),
                'availability': {'finite_features': [True]*62, 'continuous_features': [True]*62}}
        vm = Mock()
        research = SimpleNamespace(_context=Mock(return_value=data), batch_buffers=Mock(return_value=(vm, Mock())),
                                   factor_context=Mock(side_effect=AssertionError('Repeated scalar VM')))
        dedup.context = SimpleNamespace(research=research)
        before, segments = list(dedup.series.items()), list(_SEG_RESULTS.items())
        snapshot = SimpleNamespace(T=8)
        with patch('engine.vm_ti.StackVM', side_effect=AssertionError('Unpooled allocation')), patch('engine.precise_ti.copy_factor', return_value=snapshot) as copy:
            dedup.prefetch_factors([[0], [1], [1], [99], []])
            self.assertEqual(list(dedup.series.items()), before)
            self.assertEqual(list(_SEG_RESULTS.items()), segments)
            research.batch_buffers.assert_called_once_with(data, 1)
            vm.dispatch.assert_called_once_with([[1]])
            copy.assert_called_once_with(vm.factors, 0, 2)
            self.assertIs(dedup.factor_series([1]), snapshot)
            self.assertEqual(list(dedup.series), [(0,), (1,)])
            self.assertIs(dedup.factor_series([0]), existing)
            self.assertEqual(list(dedup.series), [(1,), (0,)])
            research.factor_context.assert_not_called()
        self.assertEqual(list(_SEG_RESULTS.items()), segments)

    def test_training_report_reuses_frozen_calendar_only_without_trim(self):
        dedup = GpuDedup.__new__(GpuDedup)
        dedup.train, dedup.trim, dedup.train_reports = [{}]*10, 0, None
        reports = object()
        research = SimpleNamespace(_context=Mock(return_value={'reports': reports}))
        dedup.context = SimpleNamespace(research=research)
        with patch('engine.precise_ti.NumericalReports', side_effect=AssertionError('Repeated calendar upload')):
            self.assertIs(dedup.training_report(), reports)
            self.assertIs(dedup.training_report(), reports)
        research._context.assert_called_once_with(0, 10)
        dedup.trim, dedup.train_reports = 2, None
        with patch('engine.precise_ti.NumericalReports') as factory:
            self.assertIs(dedup.training_report(), factory.return_value)
            factory.assert_called_once_with(dedup.train[2:], tile=1)


if __name__ == '__main__':
    unittest.main()
