"""因子 vs 基线（买入持有）A/B 对比 —— 纯函数"""

from __future__ import annotations

from typing import Any

import numpy as np

from .evaluate import _calmar, _sortino, evaluate_factor, next_ret
from ..express import to_text
from ..features import feature_matrix
from .periods import bars_per_year
from ..vm import execute, execute_for_bars


def buy_hold_metrics(close: np.ndarray, periods: int) -> dict[str, float]:
    """买入持有基线：全程 position=1

    指标与因子侧同源（evaluate._sortino/_calmar + 算术年化）。
    此前混用 services.backtest.metrics 的复利年化实现，两侧口径不同
    会让 delta_sortino 与年化对比失真。
    """
    pnl = next_ret(close)
    return {
        "ann_ret": float(pnl.mean() * periods),
        "sortino": _sortino(pnl, periods),
        "calmar": _calmar(pnl, periods),
    }


def _slim(metrics: dict[str, Any]) -> dict[str, float]:
    """提取关键指标"""
    return {
        "ann_ret_pct": float(metrics.get("ann_ret", 0)) * 100.0,
        "sortino": float(metrics.get("sortino", 0)),
        "calmar": float(metrics.get("calmar", 0)),
    }


def compare(
    bars: list[dict[str, Any]],
    timeframe: str,
    tokens_list: list[list[int]],
    cost: float,
) -> dict[str, Any]:
    """对比多个因子公式与买入持有基线

    timeframe 决定年化基数，cost 为单位 turnover 成本率，二者均必填，
    保证因子与基线口径一致。
    """
    close = np.array([float(b.get("close") or 0) for b in bars], dtype=float)
    mat = feature_matrix(bars)
    periods = bars_per_year(bars, timeframe)
    baseline = buy_hold_metrics(close, periods)
    factors: list[dict[str, Any]] = []
    for tokens in tokens_list:
        text = to_text(tokens)
        factor = execute_for_bars(tokens, mat, bars)
        if factor is None:
            factors.append({"text": text, "ok": False, "reason": "公式无效"})
            continue
        metrics = evaluate_factor(factor, close, cost=cost, periods=periods)
        factors.append(
            {
                "text": text,
                "ok": True,
                "metrics": _slim(metrics),
                "delta_sortino": float(metrics["sortino"]) - baseline["sortino"],
                "oos_sortino": float(metrics.get("oos_sortino", 0)),
            }
        )
    return {
        "bars": len(bars),
        "periods": periods,
        "baseline": {
            "ann_ret_pct": baseline["ann_ret"] * 100.0,
            "sortino": round(baseline["sortino"], 4),
            "calmar": round(baseline["calmar"], 4),
        },
        "factors": factors,
    }
