"""Intrabar scoring regressions. Offline, no accounts or exchange orders."""
import copy
import json
import math
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'public/pykernel'))
from realtime_factor import run
from crypto_factor import _latest_position


def history():
    return [dict(time=f'{i:04}',open=100,high=120,low=80,
                 close=100+math.sin(i*.13),volume=200+10*math.sin(i),is_closed=i<599)
            for i in range(600)]


class RealtimeFactor(unittest.TestCase):
    def test_forming_price_recalculates_and_matches_kernel_without_mutating_history(self):
        bars=history(); original=copy.deepcopy(bars)
        payload=json.dumps({'params':{'factor_tokens':[0]},'volume_scale':1})
        down=copy.deepcopy(bars);down[-1]['close']=85
        up=copy.deepcopy(bars);up[-1]['close']=115
        bearish=json.loads(run(payload,json.dumps(down)))['score']
        bullish=json.loads(run(payload,json.dumps(up)))['score']
        self.assertLess(bearish,0)
        self.assertGreater(bullish,0)
        self.assertEqual(bullish,_latest_position(up,[0]))
        self.assertEqual(bars,original)

    def test_projects_only_forming_cumulative_volume(self):
        bars=history();last=bars[-1]['volume']
        with patch('realtime_factor._latest_position',return_value=0.5) as compute:
            run(json.dumps({'params':{'factor_tokens':[0]},'volume_scale':3}),json.dumps(bars))
        seen=compute.call_args.args[0]
        self.assertEqual(seen[-1]['volume'],last*3)
        self.assertEqual(seen[-2]['volume'],bars[-2]['volume'])
        self.assertEqual(bars[-1]['volume'],last)

    def test_invalid_formula_fails_closed(self):
        with self.assertRaises(ValueError):
            run(json.dumps({'params':{'factor_tokens':[]}}),json.dumps(history()))


if __name__=='__main__':
    unittest.main()
