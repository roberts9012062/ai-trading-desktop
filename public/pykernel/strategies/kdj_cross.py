"""KDJ 金叉死叉量化策略 —— 纯规则，不调用 LLM

信号（已收盘 K 线）：
- K 上穿 D → 金叉 → open_long
- K 下穿 D → 死叉 → open_short
- 可选超买超卖过滤：金叉时 K≤oversold，死叉时 K≥overbought

strategy_params:
  n_period: int  RSV 周期，默认 9
  k_period: int  K 平滑，默认 3
  d_period: int  D 平滑，默认 3
  use_zone: bool  是否启用超买超卖区过滤，默认 False
  oversold: float  默认 20
  overbought: float  默认 80
"""

from __future__ import annotations

from typing import Any

from calc import calc_kdj
from strategies.position_handlers import (
    handle_bearish,
    handle_bullish,
    position_qty_dir,
    signal_result,
)

_SNAP = "kdj_snapshot"


def normalize_kdj_params(raw: dict[str, Any] | None) -> dict[str, Any]:
    """规范化 KDJ 参数"""
    src = dict(raw or {})

    def _i(key: str, default: int, lo: int, hi: int) -> int:
        try:
            value = int(src.get(key) or default)
        except (TypeError, ValueError):
            value = default
        return max(lo, min(hi, value))

    def _f(key: str, default: float) -> float:
        try:
            return float(src.get(key) if src.get(key) is not None else default)
        except (TypeError, ValueError):
            return default

    use_zone = bool(src.get("use_zone") or False)
    oversold = max(0.0, min(50.0, _f("oversold", 20.0)))
    overbought = max(50.0, min(100.0, _f("overbought", 80.0)))
    return {
        "n_period": _i("n_period", 9, 2, 100),
        "k_period": _i("k_period", 3, 2, 50),
        "d_period": _i("d_period", 3, 2, 50),
        "use_zone": use_zone,
        "oversold": oversold,
        "overbought": overbought,
    }


def _ohlc(
    bars: list[dict[str, Any]],
) -> tuple[list[float], list[float], list[float]]:
    highs: list[float] = []
    lows: list[float] = []
    closes: list[float] = []
    for bar in bars:
        try:
            h = float(bar.get("high") or 0)
            low = float(bar.get("low") or 0)
            c = float(bar.get("close") or 0)
        except (TypeError, ValueError):
            h, low, c = 0.0, 0.0, 0.0
        if h <= 0:
            h = c
        if low <= 0:
            low = c
        highs.append(h)
        lows.append(low)
        closes.append(c)
    return highs, lows, closes


def compute_kdj_cross_signal(
    bars: list[dict[str, Any]],
    params: dict[str, Any],
    side_mode: str,
    position: dict[str, Any] | None,
) -> dict[str, Any]:
    """KDJ K/D 金叉死叉信号"""
    p = normalize_kdj_params(params)
    n = int(p["n_period"])
    k_n = int(p["k_period"])
    d_n = int(p["d_period"])
    need = n + 2
    if len(bars) < need:
        return signal_result(
            "hold",
            f"K线不足（需≥{need}根）",
            0,
            "insufficient_data",
            _SNAP,
            None,
        )

    highs, lows, closes = _ohlc(bars)
    points = calc_kdj(highs, lows, closes, n, k_n, d_n)
    i = len(points) - 1
    prev = i - 1
    k0, d0 = points[prev].get("k"), points[prev].get("d")
    k1, d1 = points[i].get("k"), points[i].get("d")
    if None in (k0, d0, k1, d1):
        return signal_result(
            "hold", "KDJ 尚未形成", 0, "kdj_not_ready", _SNAP, None
        )

    snapshot = {
        "n_period": n,
        "k_period": k_n,
        "d_period": d_n,
        "k_prev": float(k0),
        "d_prev": float(d0),
        "k_now": float(k1),
        "d_now": float(d1),
        "j_now": points[i].get("j"),
        "use_zone": p["use_zone"],
    }
    golden = float(k0) <= float(d0) and float(k1) > float(d1)
    death = float(k0) >= float(d0) and float(k1) < float(d1)
    if p["use_zone"]:
        if golden and float(k1) > float(p["oversold"]):
            golden = False
        if death and float(k1) < float(p["overbought"]):
            death = False

    pos_qty, pos_dir = position_qty_dir(position)
    mode = (side_mode or "both").strip().lower()
    if golden:
        return handle_bullish(
            mode,
            pos_qty,
            pos_dir,
            f"KDJ金叉开多 K上穿D ({n},{k_n},{d_n})",
            _SNAP,
            snapshot,
            "kdj_golden",
        )
    if death:
        return handle_bearish(
            mode,
            pos_qty,
            pos_dir,
            f"KDJ死叉开空 K下穿D ({n},{k_n},{d_n})",
            _SNAP,
            snapshot,
            "kdj_death",
        )

    if float(k1) > float(d1):
        trend = "K>D 多头"
    elif float(k1) < float(d1):
        trend = "K<D 空头"
    else:
        trend = "K≈D"
    return signal_result(
        "hold",
        f"无交叉信号（{trend}）",
        0.4,
        "none",
        _SNAP,
        snapshot,
    )
