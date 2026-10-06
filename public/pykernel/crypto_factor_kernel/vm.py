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
from .ops import OPS_CONFIG, OPS_NAMES
from .token_encoding import (
    FEAT_OFFSET,
    MAX_FEATURES,
    V2_FEATURE_COUNT,
    V3_FEAT_OFFSET,
    is_v3_tokens,
)

FEAT_COUNT: int = len(FEATURE_NAMES)

if FEAT_COUNT > V3_FEAT_OFFSET:
    raise RuntimeError(
        f"特征数 {FEAT_COUNT} 超出 v3 的 id 空间 {V3_FEAT_OFFSET}，"
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
    # 批次2续（id 40-43，与桌面端对齐）：rank/加权均值族在恒正值域上仍恒正
    "TS_CRANK_20", "TS_CRANK_60",
    "DECAY_LINEAR_10", "DECAY_LINEAR_20",
    # 批次4：WINSOR 分位裁剪/VOL_SCALE 不改变符号
    "WINSOR_20", "VOL_SCALE_20",
}
# 能恢复符号信息
SIGN_RESTORE_OPS = {
    "SUB", "DIV", "NEG",
    "TS_STD_10", "TS_STD_20", "TS_STD_60", "TS_ZSCORE_20", "TS_ZSCORE_60",
    "DELTA_1", "DELTA_5", "TS_ATR_NORM",
    "CORR_20",  # 输出 [-1,1] 对称，天然恢复符号
    "TS_DEMEAN_20", "BETA_20", "RESID_20",  # 去均值/回归残差族，恢复符号
    # 批次3/4 新增：稳健标准化/信噪比/长窗口 zscore/差分均恢复符号
    "ROBUST_ZSCORE_20", "SNR_20", "SNR_60", "TS_ZSCORE_120", "DELTA_24",
}


def token_name(token: int, v3: bool = False) -> str:
    """token → 名称（v3=True 时算子基址为 128，特征表为扩展表）"""
    token = int(token)
    feat_offset = V3_FEAT_OFFSET if v3 else FEAT_OFFSET
    feat_limit = len(FEATURE_NAMES) if v3 else V2_FEATURE_COUNT
    if token < feat_offset:
        return FEATURE_NAMES[token] if token < feat_limit else f"feat_{token}"
    idx = token - feat_offset
    return OPS_NAMES[idx] if idx < len(OPS_NAMES) else f"op_{token}"


def validate(tokens: list[int]) -> list[str]:
    """校验公式结构，返回违规原因列表（空 = 合法）"""
    violations: list[str] = []
    v3 = is_v3_tokens(tokens)
    feat_offset = V3_FEAT_OFFSET if v3 else FEAT_OFFSET
    infected = False
    chain = 0
    last_positive = None
    for i, token in enumerate(tokens):
        token = int(token)
        if token < feat_offset:
            continue
        name = token_name(token, v3=v3)
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


def _normalize_output(x: np.ndarray) -> np.ndarray:
    """因子输出标准化：时序 zscore + clip[-3,3]"""
    x = np.asarray(x, dtype=float)
    std = x.std()
    if std < 1e-6:
        return x  # 常数因子，交由上层过滤
    z = (x - x.mean()) / std
    return np.clip(z, -3.0, 3.0)


# v3（桌面端谱系）输出归一化滚动窗 —— 与桌面端 DEFAULT_NORM_WINDOW 一致
V3_NORM_WINDOW = 250

# v3 特征 id 里直连数据段的起点（桌面 52+21=73）：缺失语义与桌面 v2 契约一致
_V3_DIRECT_FLOOR = 73


def _normalize_output_v3(x: np.ndarray, norm_window: int = V3_NORM_WINDOW) -> np.ndarray:
    """v3 输出归一化：因果滚动 zscore + clip[-3,3]（桌面端 P0-2 口径）

    v2 旧路径的全样本归一化对 bar t 引入未来分布（前视），桌面端已改
    滚动窗；v3 与桌面逐位对齐必须走同款。近常数交上层 is_constant 过滤。
    """
    from .ops import ts_mean, ts_std

    x = np.asarray(x, dtype=float)
    m = ts_mean(x, norm_window)
    s = ts_std(x, norm_window)
    return np.clip((x - m) / np.maximum(s, 1e-8), -3.0, 3.0)


def execute(tokens: list[int], feat_matrix: np.ndarray, *, norm_window: int | None = None) -> np.ndarray | None:
    """栈式执行，返回 [T] 因子序列；失败返回 None

    feat_matrix: [F, T] 特征矩阵（feature_matrix() 产出）
    v2 公式（全 token < 128）：特征 token < 64，算子 token = 64 + op_id
    v3 公式（含 token >= 128）：特征 token < 128（57+ 为桌面端谱系扩展），
    算子 token = 128 + op_id（op_id 与 v2 同序）
    """
    v3 = is_v3_tokens(tokens)
    feat_offset = V3_FEAT_OFFSET if v3 else FEAT_OFFSET
    # v2 公式特征上限冻结为 57：[57,64) 在 v2 下仍是非法空洞（append 后
    # 这些 id 仅 v3 编码可达），维持旧的 None 拒绝行为
    feat_limit = feat_matrix.shape[0] if v3 else min(V2_FEATURE_COUNT, feat_matrix.shape[0])
    stack: list[np.ndarray] = []
    for token in tokens:
        token = int(token)
        if token < feat_offset:
            if token >= feat_limit:
                return None
            row = feat_matrix[token]
            if v3 and token >= _V3_DIRECT_FLOOR and not np.isfinite(row).all():
                # 桌面 v2 契约：直连特征缺失不得冒充观测——仅容忍"首个
                # 观测之前"的头部未采样；中间缺口拒绝（nan_to_num 会把
                # 缺失冒充 0 污染后续统计）
                finite = np.isfinite(row)
                if not finite.any():
                    return None
                first = int(np.argmax(finite))
                if not finite[first:].all():
                    return None
            stack.append(row)
        else:
            idx = token - feat_offset
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
    return _normalize_output_v3(stack[0], norm_window if norm_window is not None else V3_NORM_WINDOW) if v3 else _normalize_output(stack[0])


def is_constant(factor: np.ndarray) -> bool:
    """因子是否近常数（无区分度）"""
    return float(np.asarray(factor).std()) < 1e-6


# 任意类型别名，供外部 mypy 友好
_FeatMatrix = Any
