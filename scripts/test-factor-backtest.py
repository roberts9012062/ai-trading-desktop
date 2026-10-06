"""Local factor replay regressions; no network, accounts or real orders."""
import math
import sys
import unittest
from datetime import datetime, timedelta
from pathlib import Path
from unittest.mock import patch

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "public/pykernel"))
from crypto_factor_kernel.features import feature_matrix
from crypto_factor_kernel.selected_features import feature_matrix as selected_matrix
from factor_backtest import run_factor_backtest

FORMULA = [47,83,81,31,2,65,22,107,68,112,84,5,4,66,78,96,101,64,64]


def history(count=730, minutes=1440):
    rows = []
    for i in range(count):
        close = 90 + 7 * math.sin(i * .13) + math.sin(i * .59)
        opening = rows[-1]["close"] if rows else close
        rows.append(dict(time=(datetime(2023,7,1)+timedelta(minutes=i*minutes)).strftime("%Y-%m-%d %H:%M:%S"), open=opening, high=max(opening,close)+.3, low=min(opening,close)-.3, close=close, volume=200+10*math.sin(i)))
    return rows


def payload(rows, start=700, timeframe="1d"):
    return dict(symbol="ltcusdt",timeframe=timeframe,start_date=rows[start]["time"][:10],end_date=rows[-1]["time"][:10],strategy_type="factor",strategy_params={"factor_tokens":FORMULA},data_channel="binance_usdt",history_source="binance_um_archive_v1",history_timeframe=timeframe,leverage=5,margin_per_trade=100,initial_cash=10000)


class FactorBacktest(unittest.TestCase):
    def test_selected_features_exactly_match_full_matrix(self):
        rows = history(700)
        for count in (80, 300, 700):
            bars = rows[-count:]
            for tokens, norm in ((FORMULA, None), ([57, 128+7], 200), ([0, 82, 128], 200)):
                full = feature_matrix(bars, normalization_window=norm)
                selected = selected_matrix(bars, tokens, normalization_window=norm)
                offset = 128 if any(t >= 128 for t in tokens) else 64
                for token in tokens:
                    if token < offset:
                        np.testing.assert_array_equal(selected[token], full[token])

    def test_real_ltc_formula_replays_decimal_leverage_and_end_close(self):
        bars=history(); p=payload(bars); progress=[]
        report=run_factor_backtest(p,bars,progress.append)
        self.assertEqual(report["status"],"completed")
        self.assertTrue(progress)
        self.assertGreater(report["metrics"]["trade_count"],0)
        self.assertEqual(report["config"]["history_source"],"binance_um_archive_v1")
        self.assertEqual(report["trades"][-1]["action"],"close")
        self.assertEqual(report["equity_curve"][-1]["unrealized"],0)
        first=report["trades"][0]
        self.assertEqual(first["leverage"],5)
        self.assertAlmostEqual(first["margin"],100,places=2)
        self.assertEqual(first["quantity"],round(500/first["price"],8))
        self.assertNotEqual(first["quantity"],int(first["quantity"]))
        self.assertTrue(all(math.isfinite(v) for v in report["metrics"].values()))
        self.assertIsInstance(report["bars"][0]["volume"],float)
        # The injected warmup remains outside the trade/chart interval.
        self.assertTrue(all(t["time"][:10] >= p["start_date"] for t in report["trades"]))

    def test_isolated_liquidation_and_stop_execution_use_same_rules(self):
        bars=history(); p=payload(bars)
        p.update(leverage=5,margin_mode="isolated")
        bars[702]["low"]=bars[700]["close"]*.7
        with patch("factor_backtest.quant_signal",return_value={"action":"open_long","quantity":0,"reason":"test"}):
            report=run_factor_backtest(p,bars)
        self.assertTrue(any("逐仓强平" in t["reason"] for t in report["trades"]))

    def test_gap_and_wrong_source_fail_before_replay(self):
        bars=history(); p=payload(bars)
        with self.assertRaisesRegex(ValueError,"连续性"):
            run_factor_backtest(p,bars[:600]+bars[601:])
        with self.assertRaisesRegex(ValueError,"来源"):
            run_factor_backtest({**p,"history_source":"okx_archive_v1"},bars)
        with self.assertRaisesRegex(ValueError,"仅支持"):
            run_factor_backtest({**p,"strategy_type":"ai"},bars)


if __name__ == "__main__":
    unittest.main()
