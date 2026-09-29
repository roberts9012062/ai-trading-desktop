"""Precise admission must not mix engine versions or coarse/public scores."""
import copy
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'native-engine'))
from engine.precise_ti import precise


class ProvenanceTests(unittest.TestCase):
    def test_seed_and_evaluated_admission_require_current_f64_engine_version(self):
        current = 'native-gpu-v1-m2.28'
        base = {'kernel_version': 'native-gpu-v1', 'native_eval_precision': 'f64',
                'native_engine_version': current, 'sortino': 1., 'ann_ret': .1}
        variants = [base, {**base, 'native_engine_version': 'native-gpu-v1-m2.25'},
                    {**base, 'kernel_version': 'cpu-v1'}, {**base, 'native_eval_precision': 'f32'},
                    {key: value for key, value in base.items() if key != 'native_engine_version'}]
        rows = [{'tokens': [i], 'composite': 10. - i, 'metrics': metrics}
                for i, metrics in enumerate(variants)]
        payload = {'best_seen': copy.deepcopy(rows), 'evaluated': copy.deepcopy(rows),
                   'final_generation': True}
        original = copy.deepcopy(payload)
        session = SimpleNamespace(_alive=Mock(), runtime={'engine_version': current},
            prepared={'bars': [{}] * 10, 'cfg': SimpleNamespace(research_profile='crypto_ohlcv_v1')},
            strict_context=SimpleNamespace(verdicts={}, metadata={
                'train_bars': [{}] * 5, 'all_bars': [{}] * 10, 'use_test': True}),
            dedup_context=SimpleNamespace(dedup=Mock(return_value=[])),
            eval_shards=Mock(return_value=[]))
        result = precise(session, payload)
        admitted = session.dedup_context.dedup.call_args.args[0]
        self.assertEqual([tokens for _, tokens, _ in admitted], [[0], [0]])
        self.assertEqual([row['tokens'] for row in result['best_seen']], [[0], [0]])
        self.assertEqual(payload, original)
        self.assertFalse(result['champions'])


if __name__ == '__main__':
    unittest.main()
