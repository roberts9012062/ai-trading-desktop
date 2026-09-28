import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(ROOT / "native-engine"), str(ROOT / "public" / "pykernel")]
from engine.runtime import initialize_runtime
from engine.session import NativeSession
from factor_lab.vm import execute, validate, is_constant
from factor_lab.scoring.evaluate import evaluate_factor


class SessionTests(unittest.TestCase):
    def test_scheduled_tiles_preserve_original_order_duplicates_and_rejections(self):
        runtime = initialize_runtime("f64", require_cuda=True)
        start = datetime(2025, 1, 1, tzinfo=timezone.utc)
        bars = [{"time": (start + timedelta(hours=i)).isoformat(),
                 "open": 100 + np.sin(i / 13), "high": 102 + np.sin(i / 13),
                 "low": 98 + np.sin(i / 13), "close": 100 + np.sin(i / 13),
                 "volume": 1000 + i % 19} for i in range(420)]
        session = NativeSession("scheduled", runtime, "f64")
        session.load_records(bars, {"max_bars": 100_000})
        session.prepare_features({"symbol": "ETHUSDT", "timeframe": "60m",
                                  "crypto_profile": True, "train_ratio": .7,
                                  "cost": .0003, "population": 2})
        candidates = [[0], [1, 79], [0, 77, 1, 93], [0, 0, 65], [1, 79], [1]]
        expected = [item for candidate in candidates for item in session.eval_shards([candidate])]
        self.assertEqual(session.eval_shards(candidates), expected)
        session.dispose()

    def test_mixed_authority_uses_f64_and_coarse_has_no_public_metrics(self):
        runtime = initialize_runtime("mixed", require_cuda=True)
        start = datetime(2025, 1, 1, tzinfo=timezone.utc)
        bars = [{"time": (start + timedelta(hours=i)).isoformat(), "open": 100 + np.sin(i / 13),
                 "high": 102 + np.sin(i / 13), "low": 98 + np.sin(i / 13),
                 "close": 100 + np.sin(i / 13), "volume": 1000 + i % 19} for i in range(420)]
        config = {"symbol": "ETHUSDT", "timeframe": "60m", "crypto_profile": True, "train_ratio": .7, "cost": .0003}
        mixed = NativeSession("mixed", runtime, "mixed")
        strict = NativeSession("strict", runtime, "f64")
        for session in (mixed, strict):
            session.load_records(bars, {"max_bars": 100_000})
            session.prepare_features(config)
        candidates = [[0], [1], [0, 1, 65]]
        left, right = mixed.eval_shards(candidates), strict.eval_shards(candidates)
        self.assertEqual([e["composite"] for e in left], [e["composite"] for e in right])
        self.assertTrue(all(e["metrics"]["native_eval_precision"] == "f64" for e in left))
        coarse = mixed.rank_shards(candidates)
        self.assertTrue(coarse)
        self.assertTrue(all(set(e) == {"tokens", "score"} for e in coarse))
        # Coarse work cannot contaminate the next authoritative evaluation.
        self.assertEqual(left, mixed.eval_shards(candidates))
        mixed.dispose()
        strict.dispose()

    def test_frozen_input_configuration_raw_evaluation_and_disposal(self):
        runtime = initialize_runtime("f64", require_cuda=True)
        start = datetime(2025, 1, 1, tzinfo=timezone.utc)
        bars = [{"time": (start + timedelta(hours=i)).isoformat(),
                 "open": 100 + np.sin(i / 13), "high": 102 + np.sin(i / 13),
                 "low": 98 + np.sin(i / 13), "close": 100 + np.sin(i / 13),
                 "volume": 1000 + i % 19} for i in range(420)]
        cfg = {"symbol": "ETHUSDT", "timeframe": "60m", "crypto_profile": True,
               "train_ratio": .7, "cost": .0003}
        session = NativeSession("test", runtime, "f64")
        session.load_records(bars, {"max_bars": 100_000})
        bars[0]["close"] = 999
        self.assertNotEqual(session.bars[0]["close"], 999)
        with self.assertRaises(ValueError):
            session.load_records(bars, {"max_bars": 100_000})
        session.prepare_features(cfg)
        with self.assertRaises(ValueError):
            session.prepare_features({**cfg, "cost": .001})
        candidates = [[0], [1], [0, 1, 65], [0, 102], []]
        actual = session.eval_shards(candidates)
        self.assertTrue(actual)
        for item in actual:
            factor = execute(item["tokens"], session.prepared["matrix"])
            expected = evaluate_factor(factor, session.prepared["close"], .0003, session.prepared["periods"])
            self.assertEqual(item["metrics"]["kernel_version"], "native-gpu-v1")
            self.assertAlmostEqual(item["composite"], expected["composite"], delta=1e-8)
        session.dispose()
        session.dispose()
        with self.assertRaises(ValueError):
            session.eval_shards([[0]])


if __name__ == "__main__":
    unittest.main()
