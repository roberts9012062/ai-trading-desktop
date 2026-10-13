import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'public' / 'pykernel'))
from factor_lab import vm as local
from crypto_factor_kernel import vm as server
from crypto_factor_kernel.token_encoding import remap_desktop_to_v3


class SemanticParityTests(unittest.TestCase):
    def test_branch_domains_and_rejection_match_server(self):
        for tokens in ([0,70,112,95], [0,70,1,70,67,95], [0,70,71,95],
                       [0,70,1,65,79], [0,70,1,70,64,79], [0, *([95]*11)]):
            a = local.analyze(tokens)
            b = server.analyze(remap_desktop_to_v3(tokens))
            self.assertEqual(a['errors'], b['errors'])
            self.assertEqual(a['depth'], b['depth'])
            self.assertEqual(a['nodes'][-1]['signs'], b['nodes'][-1]['signs'])
        self.assertTrue(local.validate([0,70,112,95]))
        self.assertEqual(local.validate([0,70,1,65,79]), [])

    def test_shortline_features_remain_addressable(self):
        self.assertEqual(local.validate([115,77]), [])
        self.assertEqual(local.analyze([115,77])['feature_ids'], [115])

    def test_invalid_stack_fails_before_search(self):
        for tokens in ([64], [0,1], [123], [-1], [True], ["bad"]):
            self.assertTrue(local.validate(tokens))
            self.assertTrue(server.validate(tokens))

    def test_imported_ranked_results_cannot_bypass_semantic_admission(self):
        from factor_lab.search import _dedup_top
        bad=[0,70,112,95]
        self.assertEqual(_dedup_top([(10.,bad,{'sortino':10.,'ann_ret':1.,'composite':10.})],1),[])


if __name__ == '__main__': unittest.main()
