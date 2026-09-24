"""Compare cached GPU precision inputs against the unchanged stateless f64 path."""
import json
import sys
import unittest
from datetime import datetime, timedelta
from pathlib import Path
from unittest.mock import patch

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "public" / "pykernel"))
import factor_local


class GpuSessionTests(unittest.TestCase):
    def setUp(self):
        factor_local._GPU_INPUTS.clear()
        rng = np.random.default_rng(7)
        close = 1000 * np.cumprod(1 + rng.normal(0.0002, 0.018, 600))
        self.bars = [
            dict(time=(datetime(2023, 1, 1) + timedelta(days=i)).isoformat(),
                 open=float(c), close=float(c), high=float(c * 1.002),
                 low=float(c * 0.998), volume=int(rng.integers(1000, 50000)))
            for i, c in enumerate(close)
        ]
        self.base = dict(symbol="rb8888", timeframe="1d", train_ratio=0.7,
                         test_recent_bars=0, cost=None, top_n=3, walk_forward_folds=2,
                         candidates=[[0], [1], [3], [8], [0, 1, 93], [3, 79]])

    def tearDown(self):
        factor_local._GPU_INPUTS.clear()

    def call(self, mode, payload, bars):
        return json.loads(factor_local.run(json.dumps(dict(payload, mode=mode)), json.dumps(bars)))

    def test_exact_parity_multiple_generations_and_splits(self):
        for recent, ratio in [(0, 0.7), (100, 0), (0, 0)]:
            base = dict(self.base, test_recent_bars=recent, train_ratio=ratio)
            cached = dict(base, gpu_session_id=f"case-{recent}-{ratio}")
            self.call("mine_features", cached, self.bars)
            seed = []
            for _ in range(3):
                expected = self.call("mine_precise", dict(base, best_seen=seed), self.bars)
                with patch.object(factor_local, "feature_matrix", side_effect=AssertionError("recomputed features")):
                    actual = self.call("mine_precise", dict(cached, best_seen=seed), [])
                self.assertEqual(expected, actual)
                self.assertTrue(actual["best_seen"])
                seed = actual["best_seen"]
            self.call("mine_gpu_dispose", cached, [])
            self.assertNotIn(cached["gpu_session_id"], factor_local._GPU_INPUTS)

    def test_missing_mismatched_duplicate_sessions_fail_closed(self):
        cached = dict(self.base, gpu_session_id="one")
        with self.assertRaisesRegex(ValueError, "missing"):
            self.call("mine_precise", cached, [])
        self.call("mine_features", cached, self.bars)
        with self.assertRaisesRegex(ValueError, "already exists"):
            self.call("mine_features", cached, self.bars)
        with self.assertRaisesRegex(ValueError, "configuration mismatch"):
            self.call("mine_precise", dict(cached, train_ratio=0.5), [])
        with self.assertRaisesRegex(ValueError, "frozen bars"):
            self.call("mine_precise", cached, self.bars)
        self.call("mine_gpu_dispose", cached, [])
        self.call("mine_gpu_dispose", cached, [])
        self.assertEqual({}, factor_local._GPU_INPUTS)

    def test_interleaved_sessions_do_not_share_data(self):
        second = [dict(b, close=b["close"] * (1 + 0.01 * np.sin(i))) for i, b in enumerate(self.bars)]
        a = dict(self.base, gpu_session_id="a")
        b = dict(self.base, gpu_session_id="b")
        self.call("mine_features", a, self.bars)
        self.call("mine_features", b, second)
        for payload, bars in [(a, self.bars), (b, second), (a, self.bars)]:
            self.assertEqual(self.call("mine_precise", self.base, bars),
                             self.call("mine_precise", payload, []))


if __name__ == "__main__":
    unittest.main()
