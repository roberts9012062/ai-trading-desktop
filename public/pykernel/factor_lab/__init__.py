"""因子挖掘内核 —— 特征、算子、StackVM、表达式

纯函数、无 torch、无外部依赖（仅 numpy）。
"""

from __future__ import annotations

from .express import to_text
from .features import (
    FEATURE_NAMES,
    bars_signature,
    clear_feature_matrix_cache,
    compute_features,
    feature_matrix,
)
from .ops import OPS_CONFIG, OPS_NAMES, OP_INDEX, op_arity
from .vm import (
    FEAT_COUNT,
    FEAT_OFFSET,
    POSITIVE_ONLY_OPS,
    execute,
    is_constant,
    validate,
)

__all__ = [
    "FEATURE_NAMES",
    "bars_signature",
    "clear_feature_matrix_cache",
    "compute_features",
    "feature_matrix",
    "OPS_CONFIG",
    "OPS_NAMES",
    "OP_INDEX",
    "op_arity",
    "FEAT_COUNT",
    "FEAT_OFFSET",
    "POSITIVE_ONLY_OPS",
    "execute",
    "validate",
    "is_constant",
    "to_text",
]
