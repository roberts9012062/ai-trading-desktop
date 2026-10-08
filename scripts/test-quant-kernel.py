"""Local source regressions. Run with a Python environment containing numpy."""
import math
import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "public" / "pykernel"))
from strategies import compute_quant_signal, required_signal_bars
from account import VirtualAccount
from signals import apply_hard_rules, normalize_action


def bars(scale=1.):
    rows = []
    for i in range(500):
        c = 100+7*math.sin(i*.13)+math.sin(i*.59)
        o = c if not rows else rows[-1]["close"]/scale
        rows.append(dict(time=f"2026-01-{1+i//288:02} {(i//12)%24:02}:{(i%12)*5:02}:00",
                         open=o*scale,high=(max(o,c)+.3)*scale,low=(min(o,c)-.3)*scale,close=c*scale,volume=200.))
    return rows


class QuantKernelRepairs(unittest.TestCase):
    def test_pivot_reverse_matches_batch_source_and_confirmation_window(self):
        cases = json.loads((Path(__file__).resolve().parents[1]/"src/lib/hunter/pivot-fixtures.json").read_text())
        for case in cases:
            formal = case["params"]["min_right_live"] == case["params"]["right"]
            rows = [dict(time=str(b[0]), open=b[1], high=b[2], low=b[3], close=b[4], volume=b[5],
                         is_closed=b[0]/1000+3600 <= case["now"]) for b in case["rows"]
                    if not formal or b[0]/1000+3600 <= case["now"]]
            actual = "short" if case["direction"] == "long" else "long"
            out = compute_quant_signal("swing_pivot", rows, {**case["params"], "reverse_entry":True}, "both", None)
            self.assertEqual(out["action"], "open_"+actual if case["expected"] else "hold", case["name"])
            if case["expected"]:
                self.assertEqual(out["swing_snapshot"]["last_pivot"]["side"], case["direction"])

    def test_fractional_position_has_same_decision_as_whole_unit(self):
        rows=bars()
        for kind in ("ma_cross","n_breakout","macd_cross","kdj_cross","band_swing"):
            for end in range(240,501,10):
                for side in ("long","short"):
                    a=compute_quant_signal(kind,rows[end-240:end],{},"both",dict(direction=side,quantity=.005))
                    b=compute_quant_signal(kind,rows[end-240:end],{},"both",dict(direction=side,quantity=1.))
                    self.assertEqual(a["action"],b["action"],(kind,end,side))

    def test_low_price_units_do_not_change_actions(self):
        normal,tiny=bars(),bars(1e-7)
        for kind in ("ma_cross","macd_cross","band_swing"):
            for end in range(240,501,5):
                self.assertEqual(compute_quant_signal(kind,normal[end-240:end],{},"both",None)["action"],
                                 compute_quant_signal(kind,tiny[end-240:end],{},"both",None)["action"])

    def test_factor_fractional_position_closes_on_reversal(self):
        from strategies import factor_np
        with patch.object(factor_np,"_latest_position",return_value=-.9):
            out=compute_quant_signal("factor",bars(),{"factor_tokens":[0,71]},"both",dict(direction="long",quantity=.005))
        self.assertEqual(out["action"],"close")

    def test_fractional_account_and_stop_quantity(self):
        account=VirtualAccount(10000,1,.1,"rate",0,0)
        self.assertIsNotNone(account.apply("open_long",.005,100,"2026-01-01","entry"))
        stop=apply_hard_rules(account.position_dict(),95,{"loss_pct":3},{},.005)
        self.assertEqual(stop["quantity"],.005)
        action,qty=normalize_action("close",0,.005,"both",account.position_dict())
        self.assertEqual(qty,.005)
        self.assertIsNotNone(account.apply(action,qty,95,"2026-01-02","stop"))
        self.assertEqual(account.side,"flat")

    def test_invalid_data_and_unknown_strategy_fail_closed(self):
        rows=bars(); rows[-1]["close"]=0
        for kind in ("ma_cross","n_breakout","macd_cross","kdj_cross","band_swing","factor"):
            self.assertEqual(compute_quant_signal(kind,rows,{},"both",None)["signal"],"invalid_data")
        for kind in ("swing_pro","strength_entry","strength_entry_v2","unknown"):
            with self.assertRaisesRegex(ValueError,"服务器模拟引擎"):
                compute_quant_signal(kind,bars(),{},"both",None)

    def test_long_window_is_available(self):
        self.assertGreaterEqual(required_signal_bars("ma_cross","5m",{"slow_period":500}),501)
        self.assertGreater(required_signal_bars("factor","1m",{"factor_tokens":[0,71]}),2880)


if __name__ == "__main__":
    unittest.main()
