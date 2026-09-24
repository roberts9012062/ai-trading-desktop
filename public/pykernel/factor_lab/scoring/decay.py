"""因子衰减监控 —— 预测力（IC）口径与近端盈亏口径

E10/E10b 实验（docs/experiments/factor-improvements-RESULTS.md）结论：
- trailing-60 sortino ≤0 **反向前瞻**（被标记点后中位 +1.04 vs +0.09，
  冠军正漂移下短窗负盈亏是正常回撤）——不可作为衰减判定；
- **trailing-250 IC ≤0 有效**（前瞻 60 根中位差 -0.313，n=96）——IC 是
  中心化统计量、不受仓位/成本干扰，长窗归零=预测力死亡。
衰减判定一律用 IC 口径（rolling_health）；rolling_sortino 仅作信息展示。
"""

from __future__ import annotations

from typing import Any

import numpy as np

from data.contracts import get_code_for_symbol

from ..features import feature_matrix
from ..vm import execute, validate
from .cost import DEFAULT_SLIPPAGE_TICKS, turnover_cost_rate
from .evaluate import _sortino, _ts_ic, next_ret, position_from_factor
from .periods import bars_per_year

# 滚动窗口与判定阈值
DECAY_WINDOW_BARS = 60
DECAY_THRESHOLD = 0.0
# 衰减判定口径（E10b 预登记验证）：250 根滚动 IC ≤ 0
DECAY_IC_WINDOW = 250
DECAY_IC_THRESHOLD = 0.0


def _resolve_cost_from_bars(bars: list[dict[str, Any]]) -> float:
    code = get_code_for_symbol(str(bars[-1].get("symbol") or "")) or "rb"
    valid = [float(b.get("close") or 0) for b in bars]
    valid = [c for c in valid if c > 0]
    price = sorted(valid)[-1] if valid else 0.0
    return turnover_cost_rate(code, price, DEFAULT_SLIPPAGE_TICKS)


def rolling_sortino(
    tokens: list[int],
    bars: list[dict[str, Any]],
    timeframe: str,
    cost: float | None = None,
    window: int = DECAY_WINDOW_BARS,
) -> dict[str, Any] | None:
    """因子最近 window 根 bar 的滚动盈亏指标（信息展示，不作衰减判定）"""
    if len(bars) < window + 5 or not tokens or validate(list(tokens)):
        return None
    mat = feature_matrix(bars)
    factor = execute(list(tokens), mat)
    if factor is None:
        return None
    if cost is None:
        cost = _resolve_cost_from_bars(bars)
    close = np.array([float(b.get("close") or 0) for b in bars], dtype=float)
    periods = bars_per_year(bars, timeframe)
    pos = position_from_factor(factor)
    ret = next_ret(close)
    prev = np.roll(pos, 1)
    prev[0] = 0.0
    to = np.abs(pos - prev)
    pnl = pos * ret - to * cost
    recent = pnl[-window:]
    sor = float(_sortino(recent, periods))
    return {
        "live_sortino": round(sor, 3),
        "live_ann": round(float(recent.mean() * periods), 4),
        "window": window,
        "bars": len(bars),
        "decay": sor <= DECAY_THRESHOLD,
    }


def rolling_health(
    tokens: list[int],
    bars: list[dict[str, Any]],
    timeframe: str,
    cost: float | None = None,
    ic_window: int = DECAY_IC_WINDOW,
) -> dict[str, Any] | None:
    """因子健康度（衰减判定用 IC 口径，E10b 验证）

    decay = 最近 ic_window 根的 ts_ic（因子值对下根收益）≤ 0。
    返回 {trailing_ic, ic_window, live_sortino, live_ann, window, bars,
    decay}；数据不足/因子无效返回 None。
    """
    if len(bars) < ic_window + 5 or not tokens or validate(list(tokens)):
        return None
    mat = feature_matrix(bars)
    factor = execute(list(tokens), mat)
    if factor is None:
        return None
    close = np.array([float(b.get("close") or 0) for b in bars], dtype=float)
    periods = bars_per_year(bars, timeframe)
    ret = next_ret(close)
    ic = float(_ts_ic(factor[-ic_window:], ret[-ic_window:]))

    if cost is None:
        cost = _resolve_cost_from_bars(bars)
    pos = position_from_factor(factor)
    prev = np.roll(pos, 1)
    prev[0] = 0.0
    recent = (pos * ret - np.abs(pos - prev) * cost)[-DECAY_WINDOW_BARS:]
    return {
        "trailing_ic": round(ic, 4),
        "ic_window": ic_window,
        "live_sortino": round(float(_sortino(recent, periods)), 3),
        "live_ann": round(float(recent.mean() * periods), 4),
        "window": DECAY_WINDOW_BARS,
        "bars": len(bars),
        "decay": ic <= DECAY_IC_THRESHOLD,
    }
