"""冠军组合评估 —— 相关性去重后的 top-N 因子组合

N 个低相关中等因子的组合通常优于单个最强因子（分散化提升 Sortino），
这是"挖出更有价值策略"的最终落地形态：搜索的产出不应该是 10 个候选，
而应该是 1 个组合 + 组合内各因子分工。
"""

from __future__ import annotations

from typing import Any

import numpy as np

from ..features import feature_matrix
from ..vm import execute
from .evaluate import _calmar, _sortino, _ts_ic, next_ret, position_from_factor
from .periods import bars_per_year


def evaluate_portfolio(
    bars: list[dict[str, Any]],
    timeframe: str,
    tokens_list: list[list[int]],
    cost: float,
    eval_from: int | None = None,
) -> dict[str, Any] | None:
    """等权 + IC 加权组合指标，并与最优单因子对照

    仅接受 ≥2 个可执行因子；返回 None 表示无法组合。
    因子不足或全部同质（相关性去重前）时组合意义有限，由 avg_abs_corr 体现。
    eval_from（桌面端本地增强）：只在 [eval_from, T) 段上计指标，IC 权重只用
    [0, eval_from) 估计（因子/仓位仍在全段因果计算，段首无预热失真）；
    None 时全段评估，与原口径逐位一致。
    """
    if len(tokens_list) < 2:
        return None
    mat = feature_matrix(bars)
    close = np.array([float(b.get("close") or 0) for b in bars], dtype=float)
    periods = bars_per_year(bars, timeframe)
    ret = next_ret(close)
    lo = int(eval_from or 0)

    factors: list[np.ndarray] = []
    ics: list[float] = []
    positions: list[np.ndarray] = []
    for tokens in tokens_list:
        f = execute(tokens, mat)
        if f is None:
            continue
        factors.append(f)
        ics.append(_ts_ic(f[:lo], ret[:lo]) if lo else _ts_ic(f, ret))
        positions.append(position_from_factor(f))
    if len(positions) < 2:
        return None

    P = np.vstack(positions)
    K = len(positions)
    C = np.corrcoef(factors)
    off = ~np.eye(K, dtype=bool)
    avg_abs_corr = float(np.abs(C[off]).mean()) if K > 1 else 0.0

    def _metrics(pos: np.ndarray) -> dict[str, float]:
        prev = np.roll(pos, 1)
        prev[0] = 0.0
        to = np.abs(pos - prev)
        pnl = (pos * ret - to * cost)[lo:]
        return {
            "ann_ret": float(pnl.mean() * periods),
            "sortino": float(_sortino(pnl, periods)),
            "calmar": float(_calmar(pnl, periods)),
        }

    equal = _metrics(P.mean(axis=0))
    w = np.clip(np.array(ics, dtype=float), 0.0, None)
    ic_weighted = None
    if float(w.sum()) > 1e-9:
        ic_weighted = _metrics((P * (w / w.sum())[:, None]).sum(axis=0))
    best_single = max((_metrics(p) for p in positions), key=lambda m: m["sortino"])
    return {
        "n_factors": K,
        "avg_abs_corr": round(avg_abs_corr, 3),
        "equal": equal,
        "ic_weighted": ic_weighted,
        "best_single": best_single,
    }
