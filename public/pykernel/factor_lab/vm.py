"""StackVM —— 栈式执行 token 序列 + 恒正感染校验

token 约定（v2 编码，见 token_encoding.py）：
  [0, FEAT_COUNT)         特征 id（对应 FEATURE_NAMES）
  [FEAT_COUNT, FEAT_OFFSET) 特征空间未使用部分，非法
  [FEAT_OFFSET, FEAT_OFFSET+O)  算子 id（对应 OPS_NAMES）

FEAT_OFFSET 冻结为常量而非 len(FEATURE_NAMES)：新增特征不再平移算子 id，
避免已持久化的 token 被解码成别的算子。

「恒正感染模型」（借鉴 AlphaMaster 思路，纯自研）：
  某些算子输出恒非负（TS_RANK/ABS），连续使用传播算子会让因子退化为
  「永远做多」的 beta 因子；只有恢复算子（SUB/TS_ZSCORE 等）能打破感染。
"""

from __future__ import annotations

from typing import Any

import numpy as np

from .features import FEATURE_NAMES
from .ops import OPS_CONFIG, OPS_NAMES, ts_mean, ts_std
from .token_encoding import FEAT_OFFSET, MAX_FEATURES

FEAT_COUNT: int = len(FEATURE_NAMES)

if FEAT_COUNT > MAX_FEATURES:
    raise RuntimeError(
        f"特征数 {FEAT_COUNT} 超出冻结的 id 空间 {MAX_FEATURES}，"
        "扩容需要同步迁移已持久化的 token"
    )


# 输出恒非负的算子（丢失符号信息）
POSITIVE_ONLY_OPS = {"TS_RANK_10", "TS_RANK_20", "TS_RANK_60", "ABS", "STEP"}
# 在恒正值域上输出仍恒正（感染传播）
INFECTED_PROPAGATING_OPS = {
    "TS_RANK_10", "TS_RANK_20", "TS_RANK_60", "ABS", "STEP",
    "TS_MA_5", "TS_MA_10", "TS_MA_20", "TS_MA_60",
    "TS_MAX_10", "TS_MAX_20", "TS_MIN_10",
    "SQRT", "SIGNED_LOG", "SIGMOID", "TANH",
    "LAG_1", "LAG_5",  # 恒等传递，感染不灭
    "EMA_5", "EMA_20",  # 平滑传递，同 MA 族
}
# 能恢复符号信息
SIGN_RESTORE_OPS = {
    "SUB", "DIV", "NEG",
    "TS_STD_10", "TS_STD_20", "TS_STD_60", "TS_ZSCORE_20", "TS_ZSCORE_60",
    "DELTA_1", "DELTA_5", "TS_ATR_NORM",
    "CORR_20",  # 输出 [-1,1] 对称，天然恢复符号
    "TS_DEMEAN_20", "BETA_20", "RESID_20",  # 去均值/回归残差族，恢复符号
}


def token_name(token: int) -> str:
    """token → 名称"""
    token = int(token)
    if token < FEAT_OFFSET:
        return FEATURE_NAMES[token] if token < FEAT_COUNT else f"feat_{token}"
    idx = token - FEAT_OFFSET
    return OPS_NAMES[idx] if idx < len(OPS_NAMES) else f"op_{token}"


def validate(tokens: list[int]) -> list[str]:
    """校验公式结构，返回违规原因列表（空 = 合法）"""
    violations: list[str] = []
    infected = False
    chain = 0
    last_positive = None
    for i, token in enumerate(tokens):
        token = int(token)
        if token < FEAT_OFFSET:
            continue
        name = token_name(token)
        if name in POSITIVE_ONLY_OPS:
            if not infected:
                infected = True
                last_positive = name
            chain += 1
        elif infected and name in SIGN_RESTORE_OPS:
            infected = False
            chain = 0
            last_positive = None
        elif infected and name in INFECTED_PROPAGATING_OPS:
            chain += 1
            if chain >= 3:
                violations.append(
                    f"步骤{i}: 恒正感染链过长（{last_positive} 起 {chain} 个传播算子），因子将退化为 beta"
                )
    if infected and chain >= 2:
        violations.append(f"公式末尾恒正感染（链长 {chain}），输出偏单方向")
    return violations


DEFAULT_NORM_WINDOW = 250


def _normalize_output(x: np.ndarray, window: int = DEFAULT_NORM_WINDOW, causal: bool = False) -> np.ndarray:
    """因子输出标准化:因果滚动 zscore + clip[-3,3]

    P0-2 修复:原实现用全样本 mean/std——bar t 的因子值被 t 之后的数据
    归一化过,下游 position_from_factor(固定阈值/tanh)使 bar t 的仓位
    取决于整段(含未来)的因子分布,构成全局前视:污染搜索适应度、样本外
    门控与 walk-forward,且实盘(只能用截止当下的历史)不可复现。
    现改为与特征层 _zscore_causal 同源的滚动窗(默认 250,可由调用方
    传入),头部按部分窗口退化(与 ts_mean/ts_std 语义一致)。
    近常数序列(std<1e-6)原样返回,交上层 is_constant 过滤。
    """
    x = np.asarray(x, dtype=float)
    if not causal and float(x.std()) < 1e-6:
        return x
    m = ts_mean(x, window)
    s = ts_std(x, window)
    return np.clip((x - m) / np.maximum(s, 1e-8), -3.0, 3.0)


def execute(
    tokens: list[int],
    feat_matrix: np.ndarray,
    norm_window: int = DEFAULT_NORM_WINDOW,
) -> np.ndarray | None:
    """栈式执行，返回 [T] 因子序列；失败返回 None

    feat_matrix: [F, T] 特征矩阵（feature_matrix() 产出）
    norm_window: 输出归一化滚动窗(P0-2 因果口径)
    """
    stack: list[np.ndarray] = []
    for token in tokens:
        token = int(token)
        if token < FEAT_OFFSET:
            if token >= feat_matrix.shape[0]:
                return None
            stack.append(feat_matrix[token])
        else:
            idx = token - FEAT_OFFSET
            if idx < 0 or idx >= len(OPS_CONFIG):
                return None
            _, fn, arity = OPS_CONFIG[idx]
            if len(stack) < arity:
                return None
            args = [stack.pop() for _ in range(arity)]
            args.reverse()
            try:
                res = fn(*args)
            except Exception:
                return None
            res = np.nan_to_num(
                np.asarray(res, dtype=float),
                nan=0.0,
                posinf=1.0,
                neginf=-1.0,
            )
            stack.append(res)
    if len(stack) != 1:
        return None
    return _normalize_output(stack[0], norm_window, causal=any(40 <= t < 64 or t >= 104 for t in tokens))


def is_constant(factor: np.ndarray) -> bool:
    """因子是否近常数（无区分度）"""
    return float(np.asarray(factor).std()) < 1e-6


# 任意类型别名，供外部 mypy 友好
_FeatMatrix = Any
