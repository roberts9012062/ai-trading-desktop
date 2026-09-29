"""G3 must include every generation and sample CPU/IPC gaps in mining."""
import importlib.util
import tempfile
import unittest
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location('native_generations_bench', ROOT/'scripts/bench-native-gpu-generations.py')
BENCH = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BENCH)


class PerformanceGateTests(unittest.TestCase):
    def test_all_hundred_generations_and_measured_utilization_are_required(self):
        result = {'bars': 70174, 'config': {'population': 3000, 'generations': 100},
                  'generations': [{'generation': i, 'elapsedMs': 5000} for i in range(1, 101)]}
        from engine.qualification import qualify_candidates
        result['qualification_requirements'] = {'test_required': True, 'wf_folds': 0, 'holdout_required': False}
        result['research_candidates'] = [{'tokens': [0], 'composite': 1., 'metrics': {
            'sortino': 1., 'ann_ret': .1, 'native_strict_passed': True, 'test_metrics': {'sortino': 1., 'bars': 200}}}]
        qualified = qualify_candidates(result['research_candidates'], result['qualification_requirements'], final_generation=True)
        result.update(champions=qualified['champions'], pending_candidates=qualified['pending'], rejected_candidates=qualified['rejected'])
        sampling = {'coverage': 1.0, 'sample_count': 100, 'utilization_time_weighted_percent': 60, 'vram_peak_fraction': .69}
        self.assertTrue(BENCH.acceptance(result, sampling)['passed'])
        result['generations'][0]['elapsedMs'] = 5000.01
        self.assertFalse(BENCH.acceptance(result, sampling)['passed'])
        result['generations'][0]['elapsedMs'] = 5000
        self.assertFalse(BENCH.acceptance(result, {**sampling, 'utilization_time_weighted_percent': 59.9})['passed'])
        self.assertFalse(BENCH.acceptance({**result, 'generations': result['generations'][:3]}, sampling)['passed'])
        self.assertFalse(BENCH.acceptance(result, {**sampling, 'coverage': .98})['passed'])
        self.assertFalse(BENCH.acceptance({**result, 'champions': result['research_candidates']}, sampling)['passed'])
        self.assertFalse(BENCH.acceptance(result, {**sampling, 'vram_peak_fraction': .7})['passed'])

    def test_sampling_weights_all_wall_time_and_excludes_startup(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp)/'gpu.csv'
            path.write_text('2026/09/28 10:00:00.000, 0, 100, 3000, 6000\n'
                            '2026/09/28 10:00:01.000, 0, 80, 3500, 6000\n'
                            '2026/09/28 10:00:02.000, 0, 0, 4000, 6000\n'
                            '2026/09/28 10:00:05.000, 0, 100, 1000, 6000\n', encoding='utf-8')
            start = datetime(2026, 9, 28, 10, 0, 1).timestamp()*1000
            result = BENCH.sampling_summary(path, start, start+4000)
            self.assertEqual(result['coverage'], 1)
            self.assertEqual(result['utilization_time_weighted_percent'], 20)
            self.assertEqual(result['vram_peak_mb'], 4000)


if __name__ == '__main__':
    unittest.main()
