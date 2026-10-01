"""Precise shortlist, dedup, enrichment and holdout against the CPU oracle."""
import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch
from datetime import datetime, timedelta, timezone

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(ROOT / 'native-engine'), str(ROOT / 'public/pykernel'), str(Path(__file__).parent)]
from engine.runtime import initialize_runtime
from engine.session import NativeSession
from test_features import feature_bars
from factor_local import run_mine_precise


class PreciseTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.runtime = initialize_runtime('f64', require_cuda=True)

    def compare(self, native, cpu, path='result'):
        if isinstance(cpu, dict):
            for k, v in cpu.items():
                if k == 'kernel_version':
                    continue
                self.assertIn(k, native, path)
                self.compare(native[k], v, path+'/'+k)
        elif isinstance(cpu, list):
            self.assertEqual(len(native), len(cpu), path)
            for i, (a, b) in enumerate(zip(native, cpu)):
                self.compare(a, b, path+f'/{i}')
        elif isinstance(cpu, float):
            self.assertAlmostEqual(native, cpu, delta=1e-7, msg=path)
        else:
            self.assertEqual(native, cpu, path)

    def check(self, config, count, final=True, daily=False):
        bars = feature_bars(count)
        if daily:
            start = datetime(2020, 1, 1, tzinfo=timezone.utc)
            for i, b in enumerate(bars):
                b['time'] = (start+timedelta(days=i)).isoformat()
        candidates = [[0], [1], [0, 1, 64], [0, 1, 65], [1, 0, 65], [2], [3], [4], [5], [0]]
        payload = {**config, 'candidates': candidates, 'trials': 3000, 'final_generation': final}
        expected = json.loads(run_mine_precise(payload, bars))
        session = NativeSession('precise', self.runtime, 'f64')
        try:
            session.load_records(bars, {'max_bars': 100000})
            session.prepare_features(config)
            with patch('factor_lab.search._dedup_top', side_effect=AssertionError('CPU dedup execution')), \
                 patch('factor_lab.scoring.evaluate.evaluate_factor', side_effect=AssertionError('CPU metrics execution')), \
                 patch('factor_lab.features.compute_features', side_effect=AssertionError('CPU features execution')):
                actual = session.precise({'candidates': candidates, 'trials': 3000, 'final_generation': final})
            self.compare({**actual, 'champions': actual['research_candidates']}, expected)
            self.assertTrue(actual['research_candidates'])
            self.assertTrue(all(c['metrics']['kernel_version'] == 'native-gpu-v1' for c in actual['research_candidates']))
            self.assertTrue(all(c['qualification']['status'] == 'qualified' for c in actual['champions']))
            self.assertEqual(len(actual['research_candidates']), len(actual['champions'])+
                             len(actual['pending_candidates'])+len(actual['rejected_candidates']))
            return actual
        finally:
            session.dispose()

    def test_legacy_selection_robust_dedup_dsr_and_final_holdout(self):
        self.check({'symbol': 'ETHUSDT', 'timeframe': '15m', 'crypto_profile': True,
                    'cost': .0003, 'train_ratio': .7, 'selection_v2': True,
                    'walk_forward_folds': 2, 'top_n': 3}, 2401)

    def test_v2_insufficient_is_exploratory_without_holdout(self):
        actual = self.check({'symbol': 'ETHUSDT', 'timeframe': '15m', 'research_profile': 'crypto_local_v2',
                            'cost': .0003, 'top_n': 3}, 650)
        self.assertFalse(actual['champions'])
        self.assertTrue(all(c['metrics']['candidate_status']=='exploratory' for c in actual['research_candidates']))
        self.assertTrue(all('holdout_metrics' not in c['metrics'] for c in actual['research_candidates']))

    def test_intermediate_legacy_keeps_holdout_sealed(self):
        actual = self.check({'symbol': 'ETHUSDT', 'timeframe': '15m', 'crypto_profile': True,
                            'cost': .0003, 'train_ratio': .7, 'selection_v2': True, 'top_n': 2}, 1001, False)
        self.assertFalse(actual['champions'])
        self.assertTrue(all('holdout_metrics' not in c['metrics'] for c in actual['research_candidates']))

    def test_v2_final_holdout_and_joint_peer_training(self):
        peer = feature_bars(1201)
        self.check({'symbol': 'ETHUSDT', 'timeframe': '15m', 'crypto_profile': True,
                    'cost': .0003, 'train_ratio': .7, 'joint_training': True,
                    'cross_peers': [('BTCUSDT', peer)], 'top_n': 2}, 1201)
        self.check({'symbol': 'ETHUSDT', 'timeframe': '1d', 'research_profile': 'crypto_local_v2',
                    'cost': .00001, 'top_n': 2}, 2001, daily=True)

    def test_shortline_v2_family_final_holdout_revealed(self):
        # 回归:shortline_v1 属 v2 语义族,末代封存解封必须与 crypto_local_v2
        # 一致。修复前 precise 只字面匹配 crypto_local_v2,短线任务末代
        # holdout_metrics 永远缺失 → 资格判定全数 holdout_failed_or_missing
        # (真实任务 qualified=0/pending=40,训练端 best_composite 2.59)。
        # 15001 根 15m ≈ 156 天:验证/封存段各需 ≥30 自然日(split_plan),
        # 更短的历史会让 plan.sufficient=False,封存解封无从触发
        bars = feature_bars(15001)
        for i, b in enumerate(bars):
            volume = float(b.get('volume') or 0)
            buy = float(b.get('taker_buy_volume') or 0)
            b['sl_of0'] = (2 * buy / volume - 1) if volume > 0 and 0 <= buy <= volume else 0.0
            # 超慢正弦(周期约 3000 根):低翻转率,避免短线惩罚把 composite
            # 全部清零导致 strict 池为空、封存解封无从触发
            for k in range(1, 8):
                b[f'sl_of{k}'] = float(np.sin(i / (500.0 + k)))
        config = {'symbol': 'ETHUSDT', 'timeframe': '15m', 'crypto_profile': True,
                  'research_profile': 'shortline_v1', 'cost': .0003,
                  'train_ratio': .7, 'selection_v2': True, 'walk_forward_folds': 2, 'top_n': 3}
        candidates = [[0], [1], [0, 1, 64], [0, 1, 65], [1, 0, 65], [2], [3], [4], [5], [0]]
        session = NativeSession('precise-sl', self.runtime, 'f64')
        try:
            session.load_records(bars, {'max_bars': 100000})
            info = session.prepare_features(config)
            self.assertEqual(len(info['feature_names']), 70)
            # trials=0:合成 K 线的特征列带 NaN 前缀(head_trim>0)会触发既有的
            # DSR 日历失配(与 legacy 两个存量失败同源,与封存解封无关)
            actual = session.precise({'candidates': candidates, 'trials': 0, 'final_generation': True})
            self.assertTrue(actual['research_candidates'])
            self.assertFalse(actual['pending_candidates'], '末代不应留有封存待定候选')
            graded = actual['champions'] + actual['rejected_candidates']
            revealed = [c for c in graded if 'holdout_metrics' in (c.get('metrics') or {})]
            self.assertTrue(revealed, '末代必须产出封存段指标')
            for c in revealed:
                self.assertIn('sortino_2x', c['metrics']['holdout_metrics'])
        finally:
            session.dispose()


if __name__ == '__main__':
    unittest.main()
