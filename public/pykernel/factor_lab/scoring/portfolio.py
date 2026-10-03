"""冠军组合评估 —— 相关性去重后的 top-N 因子组合

N 个低相关中等因子的组合通常优于单个最强因子（分散化提升 Sortino），
这是"挖出更有价值策略"的最终落地形态：搜索的产出不应该是 10 个候选，
而应该是 1 个组合 + 组合内各因子分工。
"""

from __future__ import annotations

from typing import Any

import numpy as np

from ..features import feature_matrix
from ..vm import execute, execute_for_bars
from .evaluate import _calmar, _sortino, _ts_ic, next_ret, position_from_factor
from .periods import bars_per_year


def evaluate_portfolio(
    bars: list[dict[str, Any]],
    timeframe: str,
    tokens_list: list[list[int]],
    cost: float,
    eval_from: int | None = None,
    *,
    combo_super: bool = False,
    walk_forward_folds: int = 0,
    wf_lo: int | None = None,
    wf_hi: int | None = None,
) -> dict[str, Any] | None:
    """等权 + IC 加权组合指标，并与最优单因子对照

    仅接受 ≥2 个可执行因子；返回 None 表示无法组合。
    因子不足或全部同质（相关性去重前）时组合意义有限，由 avg_abs_corr 体现。
    eval_from（桌面端本地增强）：只在 [eval_from, T) 段上计指标，IC 权重只用
    [0, eval_from) 估计（因子/仓位仍在全段因果计算，段首无预热失真）；
    None 时全段评估，与原口径逐位一致。

    combo_super（组合因子勾选）：追加以下口径，与原生引擎 portfolio_ti 同构——
    1×/2× 双成本计分 + 折检验区域 [wf_lo, wf_hi) 按任务折数均分的每折 Sortino；
    模式通过 = 2× Sortino>0 且折全正，等权或 IC 加权任一通过即 super_passed。
    关闭时返回结构与原口径逐位一致。
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
        f = execute_for_bars(tokens, mat, bars)
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

    def _metrics(pos: np.ndarray, lo_: int = 0, hi_: int | None = None, scale: float = 1.0) -> dict[str, float]:
        hi_ = len(pos) if hi_ is None else hi_
        prev = np.roll(pos, 1)
        prev[0] = 0.0
        to = np.abs(pos - prev)
        pnl = (pos * ret - to * cost * scale)[lo_:hi_]
        return {
            "ann_ret": float(pnl.mean() * periods),
            "sortino": float(_sortino(pnl, periods)),
            "calmar": float(_calmar(pnl, periods)),
        }

    equal = _metrics(P.mean(axis=0), lo)
    w = np.clip(np.array(ics, dtype=float), 0.0, None)
    has_weights = float(w.sum()) > 1e-9
    weighted_pos = (P * (w / w.sum())[:, None]).sum(axis=0) if has_weights else None
    ic_weighted = _metrics(weighted_pos, lo) if has_weights else None
    best_single = max((_metrics(p, lo) for p in positions), key=lambda m: m["sortino"])
    result = {
        "n_factors": K,
        "avg_abs_corr": round(avg_abs_corr, 3),
        "equal": equal,
        "ic_weighted": ic_weighted,
        "best_single": best_single,
    }
    if not combo_super:
        return result

    equal_pos = P.mean(axis=0)
    result["equal_2x"] = _metrics(equal_pos, lo, scale=2.0)
    result["ic_weighted_2x"] = _metrics(weighted_pos, lo, scale=2.0) if has_weights else None
    result["best_single_2x"] = max((_metrics(p, lo, scale=2.0) for p in positions), key=lambda m: m["sortino"])

    # 折检验:组合仓位在 [wf_lo, wf_hi) 按折数均分,每折 1× Sortino 全正
    folds = int(walk_forward_folds or 0)
    if folds > 0 and wf_lo is not None and wf_hi is not None and wf_hi - wf_lo >= folds:
        fold_bounds = np.linspace(wf_lo, wf_hi, folds + 1).astype(int)

        def _fold_sortinos(pos: np.ndarray) -> list[float]:
            return [_metrics(pos, int(fold_bounds[i]), int(fold_bounds[i + 1]))["sortino"] for i in range(folds)]

        fold_detail: dict[str, list[float] | None] = {"equal": _fold_sortinos(equal_pos)}
        fold_detail["ic_weighted"] = _fold_sortinos(weighted_pos) if has_weights else None
        result["wf_fold_sortinos"] = fold_detail["equal"]
        result["wf_fold_sortinos_ic"] = fold_detail["ic_weighted"]
        result["wf_stable"] = all(v > 0 for v in fold_detail["equal"])
    else:
        fold_detail = {"equal": None, "ic_weighted": None}
        result["wf_stable"] = True

    def _mode_passed(report: dict[str, float] | None, sortinos: list[float] | None) -> bool:
        if report is None:
            return False
        if not (report["sortino"] > 0):
            return False
        return sortinos is None or all(v > 0 for v in sortinos)

    equal_ok = _mode_passed(result["equal_2x"], fold_detail["equal"])
    ic_ok = _mode_passed(result.get("ic_weighted_2x"), fold_detail["ic_weighted"])
    result["combo_super"] = True
    result["super_passed"] = bool(equal_ok or ic_ok)
    if equal_ok or ic_ok:
        result["pass_mode"] = "equal" if equal_ok else "ic_weighted"
    return result
