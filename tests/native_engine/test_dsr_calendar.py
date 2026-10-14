"""DSR must use the same post-warmup training calendar as factor fitness."""
import json
import sys
import unittest
from collections import OrderedDict
from pathlib import Path
from types import SimpleNamespace

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(ROOT/'native-engine'), str(ROOT/'public/pykernel'), str(Path(__file__).parent)]
from test_features import feature_bars
from factor_lab.market import prepare_bars
from factor_lab.features import feature_matrix, signature_of
from factor_lab.search import _dedup_top, _cached_series
from factor_lab.scoring.deflated import deflated_sharpe
from factor_lab.scoring.evaluate import position_from_factor, next_ret


def expected_dsr(factor, bars, cost, trials):
    close = np.array([b['close'] for b in bars])
    position = position_from_factor(factor)
    previous = np.concatenate(([0.0], position[:-1]))
    pnl = position * next_ret(close) - np.abs(position-previous) * cost
    return round(deflated_sharpe(pnl, trials), 4)


class DsrCpuCalendarTests(unittest.TestCase):
    def test_precise_mining_with_default_selected_pool_produces_dsr(self):
        from factor_local import run_mine_precise
        from factor_lab.search import _v2_head_trim
        from factor_lab.features import active_feature_ids
        from factor_lab.feature_policy import search_feature_pool
        for profile in ('crypto_local_v2', 'shortline_v1'):
            with self.subTest(profile=profile):
                bars = feature_bars(650)
                payload = {'symbol': 'ETHUSDT', 'timeframe': '15m',
                    'research_profile': profile, 'selection_v2': True,
                    'search_feature_ids': list(range(64)), 'cost': .0003,
                    'candidates': [[0], [1]], 'trials': 3000, 'top_n': 2,
                    'final_generation': True}
                from factor_local import _split_train_test
                from factor_lab.search import SearchConfig
                prepared = prepare_bars(payload, bars)
                train, _ = _split_train_test(SearchConfig(research_profile=profile), prepared)
                matrix = feature_matrix(train)
                pool = search_feature_pool(active_feature_ids(matrix, True, max_head_gap=250),
                                           payload['search_feature_ids'], None)
                self.assertGreater(_v2_head_trim(matrix, pool), 0)
                result = json.loads(run_mine_precise(payload, bars))
                self.assertTrue(result['champions'])
                self.assertTrue(all('dsr' in c['metrics'] for c in result['champions']))

    def test_enrichment_aligns_factor_and_close_after_warmup(self):
        for profile in ('crypto_local_v2', 'shortline_v1'):
            bars = prepare_bars({'research_profile': profile, 'symbol': 'ETHUSDT'}, feature_bars(513))
            matrix = feature_matrix(bars)
            factor = _cached_series([0], matrix, signature_of(bars), bars)
            for trim in (0, 17, 73):
                with self.subTest(profile=profile, trim=trim):
                    result = _dedup_top([(1.0, [0], {'sortino': 1.0})], 1,
                        all_bars=bars, train_bars=bars, head_trim=trim,
                        selection_v2=True, trials=3000, cost=.0003,
                        prefetched={(0,): (True, {})})
                    self.assertTrue(result)
                    self.assertEqual(result[0].metrics['dsr'],
                        expected_dsr(factor[trim:], bars[trim:], .0003, 3000))


class DsrNativeCalendarTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from engine.runtime import initialize_runtime
        cls.runtime = initialize_runtime('f64', require_cuda=True)

    def test_default_enhanced_profile_completes_precise_with_warmup(self):
        from engine.session import NativeSession
        session = NativeSession('dsr-calendar', self.runtime, 'f64')
        try:
            session.load_records(feature_bars(650), {'max_bars': 100000})
            session.prepare_features({'symbol': 'ETHUSDT', 'timeframe': '15m',
                'crypto_profile': True, 'selection_v2': True, 'cost': .0003,
                'search_feature_ids': list(range(64)), 'top_n': 2})
            self.assertEqual(session.prepared['cfg'].research_profile, 'crypto_local_v2')
            self.assertGreater(session.prepared['head_trim'], 0)
            for final in (False, True):
                result = session.precise({'candidates': [[0], [1]], 'trials': 3000,
                                          'final_generation': final})
                self.assertTrue(result['research_candidates'])
                self.assertTrue(all('dsr' in c['metrics'] for c in result['research_candidates']))
        finally:
            session.dispose()

    def dedup(self, bars, factor, trim):
        from engine.precise_ti import GpuDedup
        from engine.metrics_ti import NumericalReports
        from engine.series_ti import GpuSeries
        dedup = GpuDedup.__new__(GpuDedup)
        dedup.bars = dedup.train = bars
        dedup.test, dedup.trim, dedup.plan = [], trim, None
        dedup.cost, dedup.timeframe = .0003, '15m'
        dedup.cfg = SimpleNamespace(selection_v2=True)
        dedup.meta = {'use_test': False, 'walk_forward_folds': 0, 'execution_model': 'signal_research'}
        dedup.session = SimpleNamespace(prepared={'bars': bars})
        dedup.series = OrderedDict([((0,), GpuSeries.upload(factor))])
        dedup.prefetched_factors, dedup.train_reports = {}, None
        report = NumericalReports(bars, tile=1)
        dedup.context = SimpleNamespace(research=SimpleNamespace(_context=lambda *args: {'reports': report}))
        return dedup

    def test_enrichment_dsr_matches_cpu_on_trimmed_and_full_calendars(self):
        bars = feature_bars(513)
        factor = np.sin(np.arange(len(bars))/11) + .1
        for trim in (0, 17, 73):
            with self.subTest(trim=trim):
                dedup = self.dedup(bars, factor[trim:], trim)
                for final in (False, True):
                    result = dedup.enrich((1.0, [0], {}), 3000, final)
                    self.assertEqual(result['metrics']['dsr'],
                        expected_dsr(factor[trim:], bars[trim:], .0003, 3000))

    def test_unexpected_factor_length_still_fails(self):
        bars = feature_bars(513)
        dedup = self.dedup(bars, np.ones(495), 17)
        with self.assertRaisesRegex(ValueError, 'calendar mismatch'):
            dedup.enrich((1.0, [0], {}), 3000, True)


if __name__ == '__main__':
    unittest.main()
