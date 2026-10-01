"""M1-only feature preparation. Read-only calls into the existing CPU oracle.

M2 replaces this adapter with features_ti. This module never evaluates tokens,
scores metrics, or claims the features were computed on GPU.
"""
import sys
from dataclasses import fields
from pathlib import Path

import numpy as np


def prepare_features(bars, config):
    root = Path(__file__).resolve().parents[2]
    sys.path.insert(0, str(root / "public" / "pykernel"))
    import factor_local
    from factor_lab.features import FEATURE_NAMES, active_feature_ids, prefix_view_matrix
    from factor_lab.market import prepare_bars
    from factor_lab.research_context import is_v2_family, norm_window_for_bars
    from factor_lab.scoring.periods import bars_per_year
    from factor_lab.scoring.walk_forward import frozen_view
    from factor_lab.search import SearchConfig, _v2_head_trim

    prepared_bars = prepare_bars(config, bars)
    known = {field.name for field in fields(SearchConfig)}
    cfg = SearchConfig(**{k: v for k, v in config.items() if k in known and k != "cost"})
    train, _ = factor_local._split_train_test(cfg, prepared_bars)
    train = frozen_view(prepared_bars, len(train))
    matrix = prefix_view_matrix(prepared_bars, len(train))
    # v2 语义族(shortline_v1 同享 causal_v2 归一化/头修剪,与 features_ti 一致)
    v2 = is_v2_family(str(cfg.research_profile or ""))
    active = active_feature_ids(matrix, cfg.crypto_profile or v2, max_head_gap=250 if v2 else 0)
    head_trim = _v2_head_trim(matrix, active) if v2 else 0
    return {"matrix": matrix.copy(), "close": np.array([float(b.get("close") or 0) for b in train]),
            "periods": bars_per_year(train, str(config.get("timeframe") or "1d")),
            "cost": factor_local.resolve_search_cost(config, prepared_bars),
            "feature_names": list(FEATURE_NAMES), "active_feature_ids": active,
            "train_len": len(train), "total_len": len(bars), "head_trim": head_trim,
            "norm_window": norm_window_for_bars(train) if v2 else 250,
            "normalization": "causal_v2" if v2 else "legacy",
            "features_source": "cpu-reference-poc"}
