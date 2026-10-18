import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'public/pykernel'))
from factor_lab.economic_templates import economic_templates
from factor_lab.seed_templates import seed_fraction, templates_for


class EconomicTemplatesTests(unittest.TestCase):
    def test_paper_manifest_is_used_by_native_research_seeding(self):
        rows=economic_templates()
        self.assertEqual(len(rows),18)
        self.assertEqual(len({tuple(t['tokens']) for t in rows}),18)
        self.assertEqual(len([r for r in rows if r.get('sources')]),12)

    def test_all_paper_recipes_execute_causally_in_the_bundled_kernel(self):
        import numpy as np
        from factor_lab.vm import execute
        time=np.arange(900,dtype=float)
        matrix=np.array([np.sin(time/(7+i))+np.cos(time/(19+i)) for i in range(64)])
        for row in economic_templates():
            if not row.get('sources'):continue
            full=execute(row['tokens'],matrix,normalization='causal_v2')
            prefix=execute(row['tokens'],matrix[:,:700],normalization='causal_v2')
            self.assertIsNotNone(full,row['family'])
            np.testing.assert_allclose(full[:700],prefix,atol=1e-10)

    def test_unsampled_prefix_does_not_poison_valid_direct_formula(self):
        import numpy as np
        from factor_lab.vm import execute
        matrix = np.zeros((64, 600))
        matrix[61] = np.sin(np.arange(600) / 19)
        matrix[61, :222] = np.nan
        tokens = [61, 94]
        result = execute(tokens, matrix, normalization='causal_v2')
        self.assertIsNotNone(result)
        self.assertGreater(np.std(result[500:]), .1)
        prefix = execute(tokens, matrix[:, :550], normalization='causal_v2')
        np.testing.assert_allclose(result[:550], prefix, atol=1e-10)
        matrix[61, 400] = np.nan
        self.assertIsNone(execute(tokens, matrix, normalization='causal_v2'))

    def test_frozen_economic_hypotheses_match_frontend_contract(self):
        self.assertEqual([t['tokens'] for t in economic_templates()[:6]], [
            [61, 46, 65, 94], [61, 46, 65, 94, 71],
            [61, 59, 65, 94], [61, 59, 65, 94, 71],
            [60, 61, 66, 94], [60, 61, 66, 94, 71],
        ])

    def test_unavailable_inputs_are_excluded_and_first_quota_is_diverse(self):
        all_active = list(range(62))
        rows = templates_for(all_active, '15m', economic=True)
        self.assertEqual(rows[:3], [[61, 46, 65, 94], [61, 59, 65, 94], [60, 61, 66, 94]])
        self.assertEqual(len(rows), len({tuple(t) for t in rows}))
        for tokens in templates_for([46, 61], '15m', economic=True):
            self.assertTrue(all(t >= 64 or t in (46, 61) for t in tokens))
        self.assertEqual(seed_fraction(40, rows), 10)
        self.assertEqual(seed_fraction(1, rows), 0)

    def test_baseline_arm_can_exclude_new_hypotheses_without_reusing_holdout(self):
        expanded = templates_for(list(range(62)), economic=True)
        baseline = templates_for(list(range(62)), economic=False)
        self.assertTrue(set(map(tuple, baseline)).issubset(set(map(tuple, expanded))))
        self.assertEqual(len(expanded) - len(baseline), 18)
        self.assertEqual(templates_for(list(range(62))), baseline)
