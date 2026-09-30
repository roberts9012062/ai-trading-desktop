import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(ROOT / "native-engine"), str(ROOT / "public" / "pykernel")]
from engine.runtime import initialize_runtime
from engine.session import NativeSession
from factor_lab.vm import execute, validate, is_constant
from factor_lab.scoring.evaluate import evaluate_factor


class SessionTests(unittest.TestCase):
    def test_setup_freezes_metadata_without_candidate_or_holdout_evaluation(self):
        from factor_lab.features import bars_signature
        from engine.wf_ti import _SEG_RESULTS
        from engine.strict_ti import StrictContext
        from test_features import feature_bars
        runtime = initialize_runtime('f64', require_cuda=True)
        session = NativeSession('metadata', runtime, 'f64')
        session.load_records(feature_bars(2001), {'max_bars': 100000})
        before = list(_SEG_RESULTS.items())
        with patch('engine.vm_ti.StackVM.dispatch', side_effect=AssertionError('Candidate evaluation during setup')), \
             patch('engine.metrics_ti.TrainingMetrics.evaluate', side_effect=AssertionError('Training scores during setup')), \
             patch('engine.metrics_ti.NumericalReports.evaluate', side_effect=AssertionError('Holdout scores during setup')):
            session.prepare_features({'symbol': 'ETHUSDT', 'timeframe': '15m', 'crypto_profile': True,
                'train_ratio': .7, 'selection_v2': True, 'walk_forward_folds': 3, 'population': 2})
        self.assertEqual(before, list(_SEG_RESULTS.items()))
        # 0.2.48 起加密+selection_v2 自动升级 crypto_local_v2(引擎侧兜底):
        # v2 有显式计划,StrictContext 延迟到首次 strict_eval/precise 构建;
        # 无计划(legacy)时仍在 prepare 阶段预建
        if session.strict_metadata['plan'] is not None:
            self.assertIsNone(session.strict_context)
            from engine.strict_ti import StrictContext, strict_eval
            session.strict_context = StrictContext(session.prepared['bars'], session.config,
                resident=session.prepared['resident_full'], metadata=session.strict_metadata,
                signatures=session.prefix_signatures)
        self.assertIsNotNone(session.strict_context)
        self.assertTrue(all(data['last_tokens'] is None for data in session.strict_context.research.contexts.values()))
        self.assertLessEqual(sum(data['bytes'] for data in session.strict_context.research.contexts.values()), 256*1024*1024)
        self.assertTrue(all(hi <= len(session.strict_metadata['all_bars'])
                            for _, hi, _, _ in session.strict_context.research.contexts))
        self.assertIsNone(session.dedup_context)
        for (start, end), value in session.prefix_signatures.items():
            self.assertEqual(value, bars_signature(session.prepared['bars'][start:end]))
        context = StrictContext(session.prepared['bars'], session.config,
            resident=session.prepared['resident_full'], metadata=session.strict_metadata,
            signatures=session.prefix_signatures)
        with patch('engine.wf_ti.bars_signature', side_effect=AssertionError('Repeated prefix encoding')):
            for start, end in context.research.signatures:
                self.assertEqual(context.research.signature(start, end), session.prefix_signatures[start, end])
        context.dispose()
        session.dispose()
        self.assertEqual(session.prefix_signatures, {})

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
        with patch("factor_lab.features.compute_features", side_effect=AssertionError("CPU feature execution")):
            info = session.prepare_features(cfg)
        self.assertEqual(info["features_source"], "gpu-taichi")
        with self.assertRaises(ValueError):
            session.prepare_features({**cfg, "cost": .001})
        candidates = [[0], [1], [0, 1, 65], [0, 102], []]
        actual = session.eval_shards(candidates)
        self.assertTrue(actual)
        for item in actual:
            factor = execute(item["tokens"], session.prepared["matrix"].to_numpy())
            expected = evaluate_factor(factor, session.prepared["close"], .0003, session.prepared["periods"])
            self.assertEqual(item["metrics"]["kernel_version"], "native-gpu-v1")
            self.assertAlmostEqual(item["composite"], expected["composite"], delta=1e-8)
        session.dispose()
        session.dispose()
        with self.assertRaises(ValueError):
            session.eval_shards([[0]])


if __name__ == "__main__":
    unittest.main()
