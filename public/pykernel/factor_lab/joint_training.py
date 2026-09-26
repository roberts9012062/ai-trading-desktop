"""多币种联合训练(本地增强)—— 适应度在主币种 + 伙伴币种的训练段上联合计算

单币种训练时,GP 会把公式拟合到该币种某段行情的特殊形态上,验证/封存段
大概率失效。联合训练要求同一公式在多个币种的**同一训练时间窗**上都有效,
只在单一币种灵的公式适应度被压低。

时间口径(防泄露):伙伴只取 time ≤ 主币种训练段末根的 bars;伙伴的验证
判定(见 cross_validate_window)只在主币种训练段之后的时间窗上进行——
伙伴训练窗已参与适应度,属样本内,不得再当验证材料。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import numpy as np

from .features import active_feature_ids, feature_matrix
from .scoring.evaluate import evaluate_factor
from .scoring.periods import bars_per_year
from .scoring.walk_forward import MIN_TEST_BARS, WARMUP_BARS, evaluate_on_slice
from .vm import execute, execute_for_bars, is_constant

# 联合分 = 均值 − JOINT_STD_PENALTY·标准差:各币种表现越一致分越高
JOINT_STD_PENALTY = 0.5


@dataclass
class PeerTrainCtx:
    peer: str
    bars: list[dict[str, Any]]
    mat: np.ndarray
    close: np.ndarray
    periods: float
    trim: int


def _time(b: dict) -> str:
    return str(b.get("time") or "")


def build_joint_context(
    cross_peers: list[tuple[str, list[dict[str, Any]]]] | None,
    train_bars: list[dict[str, Any]],
    timeframe: str,
    v2: bool,
) -> list[PeerTrainCtx]:
    """伙伴训练段上下文(特征矩阵一次性构建);无可用伙伴返回 []"""
    if not cross_peers or not train_bars:
        return []
    cut = _time(train_bars[-1])
    if not cut:
        return []
    out: list[PeerTrainCtx] = []
    for peer, pb in cross_peers:
        seg = [b for b in pb or [] if _time(b) and _time(b) <= cut]
        # 训练窗太短的伙伴只会引入噪声,跳过
        if len(seg) < max(4 * MIN_TEST_BARS, len(train_bars) // 4):
            continue
        mat = feature_matrix(seg)
        trim = 0
        if v2:
            from .search import _v2_head_trim

            try:
                trim = _v2_head_trim(
                    mat, active_feature_ids(mat, True, max_head_gap=WARMUP_BARS)
                )
            except ValueError:
                trim = 0
        out.append(
            PeerTrainCtx(
                peer=peer,
                bars=seg,
                mat=mat,
                close=np.array([float(b.get("close") or 0) for b in seg], dtype=float),
                periods=bars_per_year(seg, timeframe),
                trim=trim,
            )
        )
    return out


def joint_score(
    tokens: list[int],
    main_comp: float,
    main_metrics: dict,
    ctx: list[PeerTrainCtx],
    cost: float,
    v2: bool,
) -> tuple[float, dict]:
    """返回 (联合排序分, 附加联合明细的 metrics 副本)。

    伙伴上因子无法执行/为常数记 composite 0(公式依赖该币种缺失的数据,
    不能算作"在该币种有效")。长度罚分与主币种同口径。
    """
    if not ctx:
        return main_comp, main_metrics
    penalty = 0.02 * max(0, len(tokens) - 12)
    comps = [main_comp]
    positives = 1 if float(main_metrics.get("sortino") or 0.0) > 0 else 0
    peer_sor: dict[str, float] = {}
    for p in ctx:
        comp = 0.0
        try:
            factor = execute_for_bars(tokens, p.mat, p.bars) if v2 else execute(tokens, p.mat)
            if factor is not None:
                f = factor[p.trim:] if p.trim else factor
                if not is_constant(f):
                    m = evaluate_factor(
                        f, p.close[p.trim:] if p.trim else p.close,
                        cost=cost, periods=p.periods,
                    )
                    comp = float(m["composite"]) - penalty
                    s = float(m["sortino"])
                    peer_sor[p.peer] = round(s, 4)
                    positives += 1 if s > 0 else 0
        except (ValueError, FloatingPointError, OverflowError):
            comp = 0.0
        comps.append(comp)
    arr = np.asarray(comps, dtype=float)
    joint = float(arr.mean() - JOINT_STD_PENALTY * arr.std())
    out = dict(main_metrics)
    out["joint_composite"] = joint
    out["joint_pos_frac"] = positives / len(comps)
    out["joint_train_sortino"] = peer_sor
    return joint, out


def wrap_evaluator(cached_eval, ctx: list[PeerTrainCtx], cost: float, v2: bool):
    """把单币种训练评估器包成联合评估器(同样按 tokens 缓存)"""
    if not ctx:
        return cached_eval
    from functools import lru_cache

    @lru_cache(maxsize=20000)
    def joint(tokens_tuple):
        tok, metrics, comp = cached_eval(tokens_tuple)
        if tok is None or metrics is None:
            return tok, metrics, comp
        comp_j, metrics_j = joint_score(list(tok), comp, metrics, ctx, cost, v2)
        return tok, metrics_j, comp_j

    return joint


def cross_validate_window(
    tokens: list[int],
    cross_peers: list[tuple[str, list[dict[str, Any]]]],
    timeframe: str,
    cost: float,
    start_time: str,
) -> tuple[bool, dict[str, float]]:
    """联合训练下的伙伴验证:只在 time > start_time(主币种训练段之后)计分,
    之前的 bars 仅作预热上下文。≥⌈K/2⌉ 个伙伴 sortino>0 通过;无材料放行。"""
    scores: dict[str, float] = {}
    for peer, pb in cross_peers:
        if not pb:
            continue
        lo = next((i for i, b in enumerate(pb) if _time(b) > start_time), len(pb))
        if len(pb) - lo < MIN_TEST_BARS:
            continue
        m = evaluate_on_slice(list(tokens), pb, lo, len(pb), timeframe, cost)
        if m is not None:
            scores[peer] = float(m["sortino"])
    if not scores:
        return True, {}
    positives = sum(1 for v in scores.values() if v > 0)
    return positives >= (len(scores) + 1) // 2, scores
