import sys
import unittest
from datetime import datetime, timedelta
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(ROOT/'native-engine'), str(ROOT/'public/pykernel')]
from engine.runtime import initialize_runtime
from engine.session import NativeSession
from engine.portfolio_ti import evaluate_portfolio, portfolio_bounds
from factor_lab.features import feature_matrix
from factor_lab.vm import execute_for_bars
from factor_lab.scoring.evaluate import next_ret, position_from_factor, _ts_ic, _sortino, _calmar
from factor_lab.scoring.periods import bars_per_year


def oracle(session, champions):
    bars = session.prepared['bars']
    train, lo, hi, segment = portfolio_bounds(session)
    matrix = feature_matrix(bars)
    factors = [execute_for_bars(row['tokens'], matrix, bars) for row in champions]
    close = np.array([b['close'] for b in bars])
    returns = next_ret(close)
    positions = np.vstack([position_from_factor(f) for f in factors])
    weights = np.clip(np.array([_ts_ic(f[:train], returns[:train]) for f in factors]), 0., None)
    total = weights.sum()
    weights = weights/total if total > 1e-9 else np.zeros(len(weights))
    periods, cost = bars_per_year(bars, session.config['timeframe']), session.prepared['cost']
    def metrics(pos):
        prev = np.roll(pos, 1); prev[0] = 0
        pnl = (pos*returns-np.abs(pos-prev)*cost)[lo:hi]
        return {'ann_ret': float(pnl.mean()*periods), 'sortino': _sortino(pnl, periods), 'calmar': _calmar(pnl, periods)}
    corr = np.corrcoef(factors)
    return {'n_factors': len(factors), 'avg_abs_corr': round(float(np.abs(corr[~np.eye(len(factors), dtype=bool)]).mean()), 3),
            'equal': metrics(positions.mean(axis=0)), 'ic_weighted': metrics((positions*weights[:, None]).sum(axis=0)) if total > 1e-9 else None,
            'best_single': max((metrics(p) for p in positions), key=lambda m: m['sortino']),
            'segment': segment, 'eval_bars': hi-lo, 'weights': weights.tolist()}


class PortfolioTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.runtime = initialize_runtime('f64', require_cuda=True)
        start = datetime(2020, 1, 1)
        x = np.arange(1201)
        price = 100*np.exp(np.cumsum(.005*np.sin(x/11)+.002*np.cos(x/19)))
        cls.bars = [{'time': (start+timedelta(days=int(i))).isoformat(), 'open': float(p*.999),
                     'high': float(p*1.01), 'low': float(p*.99), 'close': float(p), 'volume': float(100+20*np.cos(i/13))}
                    for i, p in enumerate(price)]

    def session(self, config, bars=None):
        session = NativeSession('portfolio', self.runtime, 'f64')
        session.load_records(bars or self.bars, {'max_bars': 100000})
        session.prepare_features({'symbol': 'ETHUSDT', 'timeframe': '1d', 'crypto_profile': True,
            'population': 10, 'train_ratio': .7, 'walk_forward_folds': 0, **config})
        self.addCleanup(session.dispose)
        return session

    def test_equations_match_cpu_with_explicit_training_and_scoring_boundaries(self):
        champions = [{'tokens': [0]}, {'tokens': [1]}, {'tokens': [5]}]
        for config in ({}, {'selection_v2': True}, {'research_profile': 'crypto_local_v2', 'selection_v2': True}):
            with self.subTest(config=config):
                session = self.session(config)
                first = evaluate_portfolio(session, champions, diagnostics=True)
                second = evaluate_portfolio(session, champions, diagnostics=True)
                self.assertEqual(first, second)
                expected = oracle(session, champions)
                for key in ('n_factors', 'avg_abs_corr', 'segment', 'eval_bars'):
                    self.assertEqual(first[key], expected[key])
                for key in ('equal', 'ic_weighted', 'best_single'):
                    if expected[key] is None:
                        self.assertIsNone(first[key])
                    else:
                        for metric in ('ann_ret', 'sortino', 'calmar'):
                            self.assertAlmostEqual(first[key][metric], expected[key][metric], delta=1e-9)
                np.testing.assert_allclose(first['weights'], expected['weights'], atol=1e-12, rtol=1e-9)

    def test_sealed_perturbation_cannot_fit_weights(self):
        config = {'research_profile': 'crypto_local_v2', 'selection_v2': True}
        champions = [{'tokens': [0]}, {'tokens': [1]}]
        session = self.session(config)
        before = evaluate_portfolio(session, champions, diagnostics=True)
        _, lo, _, _ = portfolio_bounds(session)
        altered = [dict(bar) for bar in self.bars]
        for i in range(lo, len(altered)):
            for key in ('open', 'high', 'low', 'close'):
                altered[i][key] *= 1+(.15 if i % 2 else -.15)
        other = self.session(config, altered)
        after = evaluate_portfolio(other, champions, diagnostics=True)
        self.assertEqual(np.array(before['weights']).tobytes(), np.array(after['weights']).tobytes())

    def test_no_training_or_zero_champions_cannot_publish_portfolio(self):
        session = self.session({'train_ratio': 0})
        self.assertIsNone(evaluate_portfolio(session, []))
        self.assertIsNone(evaluate_portfolio(session, [{'tokens': [0]}, {'tokens': [1]}]))


if __name__ == '__main__':
    unittest.main()
