import sys
import random
import unittest
from pathlib import Path
import numpy as np
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "public/pykernel"))
from factor_lab.search import SearchConfig, _search_space, _draw_feature


class RestrictedSearchTests(unittest.TestCase):
    def test_explicit_pool_applies_to_all_draws(self):
        mat = np.random.default_rng(1).normal(size=(62,400))
        cfg = SearchConfig(crypto_profile=True, search_feature_ids=[0,1,4])
        rng = random.Random(1)
        _search_space(mat,cfg,rng)
        self.assertTrue(set(_draw_feature(rng,62) for _ in range(200)) <= {0,1,4})

    def test_outside_pool_seed_cannot_bypass_restriction(self):
        mat = np.random.default_rng(1).normal(size=(62,400))
        cfg = SearchConfig(crypto_profile=True, search_feature_ids=[0],seed_tokens=[[4]])
        with self.assertRaises(ValueError):
            _search_space(mat,cfg,random.Random(1))
