"""Gate regressions: missing coverage, duplicates and nonfinite values fail."""
import importlib.util
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("native_parity", ROOT / "scripts/verify-native-gpu-parity.py")
PARITY = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PARITY)


def row(tokens, composite=1.0):
    return {"tokens": tokens, "composite": composite}


class ParityGateTests(unittest.TestCase):
    def test_precise_inputs_preserve_original_eight_worker_tie_order(self):
        candidates = [[i] for i in range(19)]
        expected = [[i] for worker in range(8) for i in range(worker, 19, 8)]
        self.assertEqual(PARITY.desktop_reference_order(candidates, 8), expected)
        # Group before candidate admission, just like the unchanged worker pool.
        expected = [[0], [], [1], [0], [2], [3], [4], [5], [6], [7]]
        self.assertEqual(PARITY.desktop_reference_order([[0], [1], [2], [3], [4], [5], [6], [7], [], [0]], 8), expected)

    def test_full_suite_refuses_missing_and_duplicate_symbol_timeframe_pairs(self):
        manifest = {"symbols": [f"S{i}" for i in range(7)], "timeframes": [f"T{i}" for i in range(4)]}
        manifest["cases"] = [{"symbol": symbol, "timeframe": frame, "bars": "bars.json",
                              "config": "config.json", "candidates": "tokens.json", "cpu_reference": "cpu.json"}
                             for symbol in manifest["symbols"] for frame in manifest["timeframes"]]
        self.assertEqual(len(PARITY.validate_suite(manifest)), 28)
        with self.assertRaises(ValueError):
            PARITY.validate_suite({**manifest, "cases": manifest["cases"][:-1]})
        with self.assertRaises(ValueError):
            PARITY.validate_suite({**manifest, "cases": manifest["cases"][:-1] + [manifest["cases"][0]]})

    def test_nonfinite_cpu_reference_never_passes(self):
        for value in (float("nan"), float("inf"), -float("inf")):
            self.assertTrue(PARITY.compare_evaluated([row([0])], [row([0], value)]))

    def test_missing_duplicate_cannot_hide_behind_token_set(self):
        self.assertTrue(PARITY.compare_evaluated([row([0])], [row([0]), row([0])]))

    def test_zero_composite_requires_native_zero(self):
        self.assertFalse(PARITY.compare_evaluated([row([0], 0.0)], [row([0], 0.0)]))
        self.assertTrue(PARITY.compare_evaluated([row([0], 1e-20)], [row([0], 0.0)]))

    def test_full_comparison_includes_champions_and_strict_verdicts(self):
        cpu = {"evaluated": [row([0]), row([1])], "champions": [row([0])],
               "strict": [{"tokens": [0], "pass": True}, {"tokens": [1], "pass": False}]}
        self.assertTrue(PARITY.compare_full_outputs(cpu, cpu)["passed"])
        changed = {**cpu, "champions": [row([1])]}
        self.assertFalse(PARITY.compare_full_outputs(changed, cpu)["passed"])
        changed = {**cpu, "strict": [{"tokens": [0], "pass": False}, {"tokens": [1], "pass": False}]}
        self.assertFalse(PARITY.compare_full_outputs(changed, cpu)["passed"])

    def test_full_comparison_refuses_missing_strict_candidate(self):
        cpu = {"evaluated": [row([0])], "champions": [row([0])],
               "strict": [{"tokens": [0], "pass": False}]}
        self.assertFalse(PARITY.compare_full_outputs({**cpu, "strict": []}, cpu)["passed"])

    def test_approved_champion_and_strict_agreement_boundaries(self):
        champions = [row([i]) for i in range(100)]
        strict = [{"tokens": [i], "pass": True} for i in range(1000)]
        cpu = {"evaluated": champions, "champions": champions, "strict": strict}
        native = {**cpu, "champions": champions[:99],
                  "strict": [{**item, "pass": False} if i == 0 else item for i, item in enumerate(strict)]}
        self.assertTrue(PARITY.compare_full_outputs(native, cpu)["passed"])
        self.assertFalse(PARITY.compare_full_outputs({**native, "champions": champions[:98]}, cpu)["passed"])
        native = {**cpu, "strict": [{**item, "pass": False} if i < 2 else item for i, item in enumerate(strict)]}
        self.assertFalse(PARITY.compare_full_outputs(native, cpu)["passed"])

    def test_two_layers_reject_missing_research_and_unqualified_public_champions(self):
        from engine.qualification import qualify_candidates
        raw = dict(row([0]), metrics={'sortino': 1., 'ann_ret': .1, 'native_strict_passed': True,
            'test_metrics': {'sortino': 1., 'bars': 200}})
        requirements = {'test_required': True, 'wf_folds': 0, 'holdout_required': False}
        qualified = qualify_candidates([raw], requirements, final_generation=True)['champions']
        cpu = {'evaluated': [raw], 'research_candidates': [raw], 'champions': qualified,
               'strict': [{'tokens': [0], 'pass': True}], 'qualification_requirements': requirements}
        self.assertTrue(PARITY.compare_full_outputs(cpu, cpu)['passed'])
        self.assertFalse(PARITY.compare_full_outputs({**cpu, 'research_candidates': []}, cpu)['passed'])
        failed = dict(raw, metrics={**raw['metrics'], 'native_strict_passed': False})
        tampered = {**cpu, 'research_candidates': [failed]}
        self.assertFalse(PARITY.compare_full_outputs(tampered, cpu)['qualification_integrity'])
        self.assertFalse(PARITY.compare_full_outputs({**cpu, 'champions': [raw]}, cpu)['passed'])


if __name__ == "__main__":
    unittest.main()
