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
    "kernel_version",
]


def kernel_version() -> str:
    """因子内核口径版本——同因子在新旧口径下指标不同，历史/收藏按此戳区分。

    2026-09-25 加密化批次（P1~P4 + 批次6）：年化基数 243 交易日→365
    自然日（所有周期的 ann/sortino/calmar 标定整体变化）；新增扩容
    批次4/5/6 特征（A 级 TA 12 + 加密日历 3 + 衍生品/跨资产 6，id
    36-56）；GP/LLM 搜索池屏蔽期货口径 TOD/NIGHT/DOW（存量 token
    执行不受影响）。与桌面端 factor_local.kernel_version() 同值同步。
    """
    return "pykernel-factor-2026-09-25.2"
