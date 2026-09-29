"""M2 reporting/execution cashflows against unchanged CPU numerical oracles."""
import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
import taichi as ti

ROOT = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(ROOT / "native-engine"), str(ROOT / "public/pykernel")]
from engine.runtime import initialize_runtime
from factor_lab.scoring.evaluate import (position_from_factor, position_live_discrete,
    next_ret, next_ret_open, session_aware_pnl, _sortino, _calmar, _ts_ic)
from factor_lab.scoring.execution import ExecutionConfig, executable_metrics, executable_cashflows
from factor_lab.scoring.periods import bars_per_year


def report_bars(T=513):
    start = datetime(2025, 1, 1, tzinfo=timezone.utc)
    bars = []
    for t in range(T):
        dt = start + timedelta(minutes=15 * t + (360 if t >= 257 else 0))
        bars.append({"time": dt.isoformat(), "open_time": dt.timestamp() * 1000,
                     "open": 100 + np.sin(t / 9), "close": 100 + np.sin(t / 11),
                     "funding_time": (start + timedelta(hours=8 * (t // 32))).timestamp() * 1000,
                     "funding_rate": .0001 * (1 if t // 32 % 2 else -1)})
    return bars


class ReportTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        initialize_runtime("f64", require_cuda=True)

    def setUp(self):
        from engine.metrics_ti import NumericalReports
        self.bars = report_bars()
        self.host = np.vstack((2 * np.sin(np.arange(513) / 13), 1.4 * np.cos(np.arange(513) / 19)))
        self.factors = ti.ndarray(ti.f64, shape=self.host.shape)
        self.factors.from_numpy(self.host)
        self.report = NumericalReports(self.bars, tile=2)

    def test_close_open_session_and_discrete_slice_reports(self):
        cost, periods, lo, hi = .0003, 365 * 96, 17, 400
        for mode in ("close", "open", "session", "discrete"):
            actual = self.report.evaluate(self.factors, 2, lo, hi, cost, periods, mode=mode, entry=.3)
            repeat = self.report.evaluate(self.factors, 2, lo, hi, cost, periods, mode=mode, entry=.3)
            self.assertEqual(actual, repeat)
            for p, row in enumerate(actual):
                factor = self.host[p, lo:hi]
                bars = self.bars[lo:hi]
                close = np.array([b["close"] for b in bars])
                pos = position_from_factor(factor)
                prev = np.concatenate(([0.0], pos[:-1]))
                if mode == "discrete":
                    full = position_live_discrete(self.host[p], entry=.3)
                    pos, prev = full[lo:hi], full[lo-1:hi-1]
                turnover = np.abs(pos - prev)
                ret = next_ret_open(np.array([b["open"] for b in bars])) if mode == "open" else next_ret(close)
                pnl = pos * ret - turnover * cost
                if mode == "session":
                    pnl = session_aware_pnl(pos, bars, cost)
                expected = {"ann_ret": pnl.mean() * periods, "sortino": _sortino(pnl, periods),
                            "calmar": _calmar(pnl, periods), "exposure": np.abs(pos).mean(),
                            "bars": hi - lo}
                if mode in ("close", "open"):
                    expected["avg_turnover"] = turnover.mean()
                if mode == "close":
                    expected["ts_ic"] = _ts_ic(factor, ret)
                if mode == "discrete":
                    expected["n_trades"] = int(np.sum((pos != 0) & (pos != prev)))
                for name, value in expected.items():
                    self.assertAlmostEqual(row[name], value, delta=1e-9, msg=f"{mode}/{name}")

    def test_batch_reports_share_readonly_inputs_and_keep_independent_outputs(self):
        from unittest.mock import patch
        with patch('factor_lab.scoring.funding.extract_funding_events', side_effect=AssertionError('Repeated calendar parsing')):
            batch = self.report.with_tile(3)
        self.assertIs(batch.source, self.report.source)
        self.assertIsNot(batch.flows, self.report.flows)
        self.assertIsNot(batch.positions, self.report.positions)
        source = self.report.source.to_numpy().tobytes()
        for mode in ('close', 'open', 'session', 'discrete', 'perp_next_open'):
            expected = self.report.evaluate(self.factors, 2, 17, 400, .0003, 35040, mode=mode)
            self.assertEqual(batch.evaluate(self.factors, 2, 17, 400, .0003, 35040, mode=mode), expected)
            batch.evaluate(self.factors, 1, 30, 300, .0006, 35040, mode=mode)
            self.assertEqual(self.report.evaluate(self.factors, 2, 17, 400, .0003, 35040, mode=mode), expected)
        self.assertEqual(self.report.source.to_numpy().tobytes(), source)
        with self.assertRaises(ValueError):
            self.report.with_tile(0)

    def test_slice_modes_reuse_positions_and_ic_only_within_the_same_frozen_call(self):
        from unittest.mock import patch
        self.report.graph_dispatch = False  # Verify the retained direct path.
        for lo, hi, cost in ((17, 400, .0003), (30, 300, .0006)):
            expected = tuple(self.report.evaluate(self.factors, 2, lo, hi, cost, 35040, mode=mode)
                             for mode in ('close', 'open', 'session'))
            target = self.report.program
            with patch.object(target, '_positions', wraps=target._positions) as positions, \
                 patch.object(target, '_means', wraps=target._means) as means, \
                 patch.object(target, '_centered', wraps=target._centered) as centered:
                actual = self.report.evaluate_slice_modes(self.factors, 2, lo, hi, cost, 35040)
                self.assertEqual(actual, expected)
                positions.assert_called_once()
                means.assert_called_once()
                centered.assert_called_once()
            # A later discrete or spot call must always rebuild its positions.
            for mode in ('discrete', 'spot_long_flat'):
                self.report.evaluate(self.factors, 2, lo, hi, cost, 35040, mode=mode)
            self.assertEqual(self.report.evaluate_slice_modes(self.factors, 2, lo, hi, cost, 35040), expected)

    def test_execution_funding_stress_and_slice_continuity(self):
        for model in ("spot_long_flat", "perp_next_open"):
            for stress in (1.0, 2.0):
                cfg = ExecutionConfig(execution_model=model, stress_multiplier=stress)
                periods = bars_per_year(self.bars[17:400], "15m")
                actual = self.report.evaluate(self.factors, 2, 17, 400, cfg.unit_cost, periods, mode=model)
                for p, row in enumerate(actual):
                    expected = executable_metrics(self.host[p], self.bars, "15m", cfg, lo=17, hi=400)
                    for name in ("ann_ret", "sortino", "calmar", "avg_turnover", "exposure", "fee_total",
                                 "funding_total", "n_funding_events", "funding_estimated", "bars"):
                        self.assertAlmostEqual(row[name], expected[name], delta=1e-9, msg=f"{model}/{name}")
                flows = self.report.cashflows(self.factors, 2, cfg.unit_cost, mode=model)
                for p in range(2):
                    expected = executable_cashflows(self.host[p], self.bars, cfg)
                    for name in ("pnl", "held", "fee", "funding_cf"):
                        np.testing.assert_allclose(flows[name][p], expected[name], rtol=1e-12, atol=1e-12,
                                                   err_msg=f"{model}/{name}")

    def test_multi_block_drawdown_and_same_timestamp_funding_order(self):
        from engine.metrics_ti import NumericalReports
        bars = report_bars(2061)
        for t, b in enumerate(bars):
            # Settlement overlaps the previous bar open. The CPU contract
            # charges held[t-2], before the next opening order is processed.
            b["funding_time"] = bars[max(0, t-1)]["open_time"]
        host = np.sin(np.arange(len(bars)) / 13)[None, :]
        factors = ti.ndarray(ti.f64, shape=host.shape)
        factors.from_numpy(host)
        reports = NumericalReports(bars, tile=1)
        cfg = ExecutionConfig()
        periods = bars_per_year(bars[17:2000], "15m")
        actual = reports.evaluate(factors, 1, 17, 2000, cfg.unit_cost, periods, mode="perp_next_open")[0]
        expected = executable_metrics(host[0], bars, "15m", cfg, lo=17, hi=2000)
        for name in ("ann_ret", "sortino", "calmar", "funding_total", "funding_estimated"):
            self.assertAlmostEqual(actual[name], expected[name], delta=1e-9, msg=name)
        np.testing.assert_allclose(reports.cashflows(factors, 1, cfg.unit_cost, mode="perp_next_open")["funding_cf"][0],
                                   executable_cashflows(host[0], bars, cfg)["funding_cf"], rtol=1e-12, atol=1e-12)


if __name__ == "__main__":
    unittest.main()
