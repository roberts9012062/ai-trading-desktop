"""Four-hour CPU/native research contract; no GPU or network required."""
import sys
import unittest
from pathlib import Path
from datetime import datetime

sys.path.insert(0, str(Path(__file__).resolve().parents[2]/'public'/'pykernel'))


class FourHourKernelTests(unittest.TestCase):
    def test_crypto_annualization_and_live_clock(self):
        from factor_lab.market import prepare_bars
        from factor_lab.scoring.periods import bars_per_year
        from bar_align import floor_bar_start, next_bar_boundary
        bars = prepare_bars(dict(symbol='btcusdt',research_profile='crypto_local_v2'),[dict(time='2026-10-01 00:00:00')])
        self.assertEqual(bars_per_year(bars, '240m'), 2190)
        at = datetime(2026,10,1,23,59,59)
        self.assertEqual(floor_bar_start(at,'240m').hour,20)
        self.assertEqual(next_bar_boundary(at,'240m').isoformat(), '2026-10-02T00:00:00+08:00')

    def test_long_history_range_and_holding_horizon(self):
        from bt_data import max_days_for
        from capital import TIMEFRAME_MAX_HOLD_DAYS
        self.assertEqual(max_days_for('240m'),365)
        self.assertEqual(TIMEFRAME_MAX_HOLD_DAYS['240m'],90)


if __name__ == '__main__':
    unittest.main()
