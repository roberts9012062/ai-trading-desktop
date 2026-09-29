"""Allocation failures must not make an incomplete session appear prepared."""
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(ROOT/'native-engine'), str(ROOT/'public/pykernel')]
from engine.session import NativeSession


class PrepareFailureTests(unittest.TestCase):
    def test_late_failure_leaves_no_published_partial_state_and_retry_rebuilds(self):
        session = NativeSession('failure', {'vram_mb': 6140}, 'mixed')
        session.load_records([{'close': 1}]*10, {'max_bars': 100000})
        prepared = {'matrix': SimpleNamespace(shape=(62, 10)), 'close': [1.]*10,
            'norm_window': 250, 'normalization': 'legacy', 'cost': .0003,
            'periods': 35040, 'head_trim': 0, 'bars': session.bars,
            'availability': {'finite_features': [True]*62, 'continuous_features': [True]*62},
            'features_source': 'gpu-taichi'}
        metadata = {'use_test': False, 'test_bars': [], 'all_bars': session.bars, 'plan': object()}
        config = {'population': 2}
        with patch('engine.features_ti.prepare_features', return_value=prepared) as features, \
             patch('engine.vm_ti.StackVM') as vm, \
             patch('engine.metrics_ti.TrainingMetrics'), \
             patch('factor_local._strict_eval_context', return_value=metadata), \
             patch('engine.signatures.report_prefix_ends', return_value={0, 10}), \
             patch('engine.signatures.freeze_prefix_signatures',
                   side_effect=[MemoryError('metadata allocation'), {(0, 10): (10, b'frozen')}]):
            with self.assertRaisesRegex(MemoryError, 'metadata allocation'):
                session.prepare_features(config)
            for name in ('prepared', 'vm', 'metrics', 'config', 'config_key',
                         'finite_features', 'strict_metadata', 'regime_inputs', 'strict_context'):
                self.assertIsNone(getattr(session, name), name)
            self.assertEqual(session.prefix_signatures, {})
            with self.assertRaisesRegex(ValueError, 'Features not prepared'):
                session.eval_shards([[0]])
            result = session.prepare_features(config)
            self.assertEqual(features.call_count, 2)
            self.assertEqual(vm.call_count, 2)
            self.assertEqual(result['features_source'], 'gpu-taichi')
            self.assertIs(session.prepared, prepared)
        session.dispose()


if __name__ == '__main__':
    unittest.main()
