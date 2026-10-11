"""Shortline research, fold evidence and live evaluation must share a window."""
import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(ROOT / 'native-engine'), str(ROOT / 'public/pykernel')]


def bars_for(minutes=240, count=1601):
    start = datetime(2025, 1, 1, tzinfo=timezone.utc)
    return [{'time': (start+timedelta(minutes=minutes*i)).isoformat(),
             '_factor_market': 'shortline_v1',
             'open': 100+np.sin(i/31)+i*.003, 'close': 100+np.sin(i/29)+i*.003,
             'high': 102+np.sin(i/29)+i*.003, 'low': 98+np.sin(i/29)+i*.003,
             'volume': 1000+i%19} for i in range(count)]


def prefix_fold_metrics(bars, tokens, plan):
    from factor_lab.features import feature_matrix
    from factor_lab.vm import execute, NORM_CAUSAL_V2
    from factor_lab.research_context import norm_window_for_bars
    from factor_lab.scoring.split_plan import plan_validation_folds
    from factor_lab.scoring.evaluate import position_from_factor, next_ret, _sortino
    from factor_lab.scoring.periods import bars_per_year
    visible = bars[:plan.validation_end]
    factor = execute(tokens, feature_matrix(visible), norm_window_for_bars(visible), NORM_CAUSAL_V2)
    result = []
    for lo, hi in plan_validation_folds(plan, 3):
        pos = position_from_factor(factor[lo:hi])
        prev = np.roll(pos, 1); prev[0] = 0
        turn = abs(pos-prev)
        ret = next_ret(np.array([b['close'] for b in bars[lo:hi]]))
        pnl = pos*ret-turn*.0005
        periods = bars_per_year(bars[lo:hi], '240m')
        result.append({'ann_ret':float(pnl.mean()*periods),
                       'sortino':float(_sortino(pnl, periods)), 'avg_turnover':float(turn.mean())})
    return result


class ShortlineCpuContractTests(unittest.TestCase):
    def test_declared_window_reaches_actual_feature_and_vm_defaults(self):
        from factor_lab.research_context import norm_window_for_bars, resolve_context
        from factor_lab.features import feature_matrix
        from factor_lab.vm import execute_for_bars, execute, NORM_CAUSAL_V2
        for minutes in (1, 5, 15, 240):
            with self.subTest(minutes=minutes):
                bars = bars_for(minutes, 701)
                ctx = resolve_context({'symbol':'SOLUSDT', 'research_profile':'shortline_v1'}, bars, .0005)
                self.assertEqual(norm_window_for_bars(bars), ctx.norm_window)
                mat = feature_matrix(bars)
                np.testing.assert_array_equal(execute_for_bars([43], mat, bars),
                                              execute([43], mat, ctx.norm_window, NORM_CAUSAL_V2))

    def test_fold_features_and_normalization_match_visible_prefix(self):
        from factor_lab.research_context import resolve_context
        from factor_lab.scoring.walk_forward import walk_forward_eval_v2
        bars = bars_for()
        plan = resolve_context({'symbol':'SOLUSDT', 'research_profile':'shortline_v1'}, bars, .0005).split
        actual = walk_forward_eval_v2([43], bars, '240m', .0005, plan, 3)
        self.assertIsNotNone(actual)
        expected = prefix_fold_metrics(bars, [43], plan)
        for row, target in zip(actual['folds'], expected):
            self.assertEqual(row['context_start'], 0)
            for name, value in target.items():
                self.assertAlmostEqual(row[name], value, delta=1e-10, msg=name)
        changed = [dict(b) for b in bars]
        for b in changed[plan.validation_end:]:
            b['close'] *= 7
            b['volume'] *= 11
        self.assertEqual(actual, walk_forward_eval_v2([43], changed, '240m', .0005, plan, 3))


class ShortlineGpuContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from engine.runtime import initialize_runtime
        initialize_runtime('f64', require_cuda=True)

    def test_training_reports_and_fold_evidence_share_declared_contract(self):
        from engine.features_ti import prepare_features
        from engine.wf_ti import GpuResearchContext, walk_forward_eval
        from factor_lab.research_context import resolve_context
        bars = bars_for()
        config = {'symbol':'SOLUSDT', 'research_profile':'shortline_v1', 'timeframe':'240m',
                  'crypto_profile':True, 'walk_forward_folds':3, 'cost':.0005}
        prepared = prepare_features(bars, config)
        self.assertEqual(prepared['norm_window'], resolve_context(config, bars, .0005).norm_window)
        plan = resolve_context(config, bars, .0005).split
        context = GpuResearchContext(bars, '240m', .0005, resident=prepared['resident_full'])
        try:
            self.assertEqual(context._context(0, plan.validation_end)['vm'].norm_window, prepared['norm_window'])
            actual = walk_forward_eval(context, [43], 3, plan=plan)
            for row, target in zip(actual['folds'], prefix_fold_metrics(bars, [43], plan)):
                self.assertEqual(row['context_start'], 0)
                for name, value in target.items():
                    self.assertAlmostEqual(row[name], value, delta=1e-8, msg=name)
        finally:
            context.dispose()


if __name__ == '__main__':
    unittest.main()
