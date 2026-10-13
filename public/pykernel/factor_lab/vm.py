"""StackVM —— 栈式执行 token 序列 + 恒正感染校验

token 约定（v2 编码，见 token_encoding.py）：
  [0, FEAT_COUNT)         特征 id（对应 FEATURE_NAMES）
  [FEAT_COUNT, FEAT_OFFSET) 特征空间未使用部分，非法
  [FEAT_OFFSET, FEAT_OFFSET+O)  算子 id（对应 OPS_NAMES）

FEAT_OFFSET 冻结为常量而非 len(FEATURE_NAMES)：新增特征不再平移算子 id，
避免已持久化的 token 被解码成别的算子。

研究准入按公式树逐分支推导值域与依赖，数值执行保持兼容。
原始单侧值域不等于最终滚动归一化后必然单边交易。
"""

from __future__ import annotations

from typing import Any

import numpy as np

from .features import FEATURE_NAMES
from .ops import OPS_CONFIG, OPS_NAMES, ts_mean, ts_std
from .token_encoding import FEAT_OFFSET, MAX_FEATURES, SHORTLINE_TOKEN_OFFSET
from .features import SHORTLINE_FEATURE_NAMES

FEAT_COUNT: int = len(FEATURE_NAMES)

if FEAT_COUNT > MAX_FEATURES:
    raise RuntimeError(
        f"特征数 {FEAT_COUNT} 超出冻结的 id 空间 {MAX_FEATURES}，"
        "扩容需要同步迁移已持久化的 token"
    )


# 输出恒非负的算子（丢失符号信息）
POSITIVE_ONLY_OPS = {"TS_RANK_10", "TS_RANK_20", "TS_RANK_60", "ABS", "STEP"}
def token_name(token: int) -> str:
    """token → 名称"""
    token = int(token)
    if token >= SHORTLINE_TOKEN_OFFSET:
        k = token - SHORTLINE_TOKEN_OFFSET
        return SHORTLINE_FEATURE_NAMES[k] if k < len(SHORTLINE_FEATURE_NAMES) else f"sl_{token}"
    if token < FEAT_OFFSET:
        return FEATURE_NAMES[token] if token < FEAT_COUNT else f"feat_{token}"
    idx = token - FEAT_OFFSET
    return OPS_NAMES[idx] if idx < len(OPS_NAMES) else f"op_{token}"


def analyze(tokens: list[int]) -> dict:
    from .semantics import inspect_formula
    return inspect_formula(tokens, FEATURE_NAMES, OPS_CONFIG, FEAT_OFFSET,
                           {SHORTLINE_TOKEN_OFFSET+i: name for i, name in enumerate(SHORTLINE_FEATURE_NAMES)})


def validate(tokens: list[int]) -> list[str]:
    return analyze(tokens)["errors"]


DEFAULT_NORM_WINDOW = 250

# 输出归一化策略(v2 显式契约,方案 2.1-C / 5.2-1)
NORM_LEGACY = "legacy"      # 旧语义:近常数全段检查分支按 token 新旧决定
NORM_CAUSAL_V2 = "causal_v2"  # crypto_local_v2:一律严格因果路径,与 token 无关


def _normalize_output(
    x: np.ndarray,
    window: int = DEFAULT_NORM_WINDOW,
    causal: bool = False,
) -> np.ndarray:
    """因子输出标准化:因果滚动 zscore + clip[-3,3]

    P0-2 修复:原实现用全样本 mean/std——bar t 的因子值被 t 之后的数据
    归一化过,下游 position_from_factor(固定阈值/tanh)使 bar t 的仓位
    取决于整段(含未来)的因子分布,构成全局前视:污染搜索适应度、样本外
    门控与 walk-forward,且实盘(只能用截止当下的历史)不可复现。
    现改为与特征层 _zscore_causal 同源的滚动窗(默认 250,可由调用方
    传入),头部按部分窗口退化(与 ts_mean/ts_std 语义一致)。
    近常数序列(std<1e-6)原样返回,交上层 is_constant 过滤。

    causal=False 时保留一个仅影响近常数短路的全段 std 检查(旧公式行为,
    逐位兼容);causal=True(v2 一律如此)连该分支也不依赖全段统计,
    前缀不变性完整。
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
    normalization: str = NORM_LEGACY,
) -> np.ndarray | None:
    """栈式执行，返回 [T] 因子序列；失败返回 None

    feat_matrix: [F, T] 特征矩阵（feature_matrix() 产出）
    norm_window: 输出归一化滚动窗(P0-2 因果口径)
    normalization: NORM_CAUSAL_V2 时输出归一化走严格因果路径(近常数
        短路也取消),与公式是否含新 token 无关 —— crypto_local_v2 的
        显式策略;NORM_LEGACY 保持旧公式逐位行为。
    """
    stack: list[np.ndarray] = []
    v2 = normalization == NORM_CAUSAL_V2
    for token in tokens:
        token = int(token)
        if token >= SHORTLINE_TOKEN_OFFSET:
            # v4 短线特征（矩阵行 FEAT_COUNT+k；仅 bars 带 sl 列时存在）
            row_idx = FEAT_COUNT + (token - SHORTLINE_TOKEN_OFFSET)
            if token >= SHORTLINE_TOKEN_OFFSET + len(SHORTLINE_FEATURE_NAMES) or row_idx >= feat_matrix.shape[0]:
                return None
            row = feat_matrix[row_idx]
            if not np.isfinite(row).all():
                if not v2:
                    return None
                finite = np.isfinite(row)
                if not finite.any():
                    return None
                first = int(np.argmax(finite))
                if not finite[first:].all():
                    return None
            stack.append(row)
            continue
        if token < FEAT_OFFSET:
            if token >= feat_matrix.shape[0]:
                return None
            if token >= 52 and not np.isfinite(feat_matrix[token]).all():
                if not v2:
                    return None  # incomplete direct-data history must not become a fabricated signal
                # v2:仅容忍"首个观测之前"的头部缺失(未采样≠观测缺口);
                # 中间缺口仍拒绝——nan_to_num 会把它冒充 0 污染后续统计
                row = feat_matrix[token]
                finite = np.isfinite(row)
                if not finite.any():
                    return None
                first = int(np.argmax(finite))
                if not finite[first:].all():
                    return None
            # The continuity guard above has already rejected interior gaps.
            # Only the legitimate unsampled prefix is neutralized for VM math;
            # admission/head trim still use the original masked matrix.
            row = feat_matrix[token]
            if v2 and token >= 52:
                row = np.where(np.isfinite(row), row, 0.0)
            stack.append(row)
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
    if normalization == NORM_CAUSAL_V2:
        return _normalize_output(stack[0], norm_window, causal=True)
    return _normalize_output(stack[0], norm_window, causal=any(40 <= t < 64 or t >= 104 for t in tokens))


def is_constant(factor: np.ndarray) -> bool:
    """因子是否近常数（无区分度）"""
    return float(np.asarray(factor).std()) < 1e-6


def execute_for_bars(
    tokens: list[int],
    feat_matrix: np.ndarray,
    bars: list,
    norm_window: int | None = None,
) -> np.ndarray | None:
    """按 bars 的市场契约选择执行策略:crypto_local_v2 → 严格因果归一化,
    legacy → 旧语义逐位不变。所有持有 bars 上下文的调用方统一走本入口,
    避免个别路径漏传 v2 策略造成 CPU/报告口径分叉。
    """
    from .market import is_v2

    if is_v2(bars):
        if norm_window is None:
            from .research_context import norm_window_for_bars

            norm_window = norm_window_for_bars(bars)
        return execute(tokens, feat_matrix, norm_window, NORM_CAUSAL_V2)
    if norm_window is None:
        return execute(tokens, feat_matrix)
    return execute(tokens, feat_matrix, norm_window)


# 任意类型别名，供外部 mypy 友好
_FeatMatrix = Any
