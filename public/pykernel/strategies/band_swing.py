"""布林带波段策略 —— 均值回归波段，纯规则

信号（已收盘 K 线）：
- 收盘价触及/跌破下轨 → 波段做多（open_long）
- 收盘价触及/升破上轨 → 波段做空（open_short）
- 持仓后收盘回到中轨一侧 → 平仓（波段结束）
- 已有同向仓 hold；反向信号先 close

strategy_params:
  period: int  中轨 SMA 周期，默认 20
  std_mult: float  标准差倍数，默认 2.0
"""

from __future__ import annotations

from typing import Any

from calc import calc_boll
from strategies.position_handlers import (
    handle_bearish,
    handle_bullish,
    position_qty_dir,
    signal_result,
)

_SNAP = "band_snapshot"


def normalize_band_params(raw: dict[str, Any] | None) -> dict[str, Any]:
    """规范化布林带波段参数"""
    src = dict(raw or {})
    try:
        period = int(src.get("period") or src.get("lookback") or 20)
    except (TypeError, ValueError):
        period = 20
    try:
        std_mult = float(
            src.get("std_mult") if src.get("std_mult") is not None else 2.0
        )
    except (TypeError, ValueError):
        std_mult = 2.0
    period = max(5, min(200, period))
    std_mult = max(0.5, min(5.0, std_mult))
    return {"period": period, "std_mult": std_mult}


def _closes(bars: list[dict[str, Any]]) -> list[float]:
    out: list[float] = []
    for bar in bars:
        try:
            out.append(float(bar.get("close") or 0))
        except (TypeError, ValueError):
            out.append(0.0)
    return out


def compute_band_swing_signal(
    bars: list[dict[str, Any]],
    params: dict[str, Any],
    side_mode: str,
    position: dict[str, Any] | None,
) -> dict[str, Any]:
    """布林带上下轨波段进出场"""
    p = normalize_band_params(params)
    period = int(p["period"])
    std_mult = float(p["std_mult"])
    if len(bars) < period + 1:
        return signal_result(
            "hold",
            f"K线不足（需≥{period + 1}根）",
            0,
            "insufficient_data",
            _SNAP,
            None,
        )

    closes = _closes(bars)
    points = calc_boll(closes, period, std_mult)
    i = len(points) - 1
    upper = points[i].get("upper")
    middle = points[i].get("middle")
    lower = points[i].get("lower")
    if None in (upper, middle, lower):
        return signal_result(
            "hold", "布林带尚未形成", 0, "band_not_ready", _SNAP, None
        )

    close = closes[i]
    snapshot = {
        "period": period,
        "std_mult": std_mult,
        "upper": float(upper),
        "middle": float(middle),
        "lower": float(lower),
        "close": close,
    }
    pos_qty, pos_dir = position_qty_dir(position)
    mode = (side_mode or "both").strip().lower()

    # 持仓波段结束：回到中轨
    if pos_qty > 0 and pos_dir == "long" and close >= float(middle):
        return signal_result(
            "close",
            f"波段平多：收盘回到中轨 {float(middle):.2f}",
            0.8,
            "band_tp_long",
            _SNAP,
            snapshot,
        )
    if pos_qty > 0 and pos_dir == "short" and close <= float(middle):
        return signal_result(
            "close",
            f"波段平空：收盘回到中轨 {float(middle):.2f}",
            0.8,
            "band_tp_short",
            _SNAP,
            snapshot,
        )

    touch_lower = close <= float(lower)
    touch_upper = close >= float(upper)
    if touch_lower:
        return handle_bullish(
            mode,
            pos_qty,
            pos_dir,
            f"波段做多：触及下轨 {float(lower):.2f}",
            _SNAP,
            snapshot,
            "band_lower",
        )
    if touch_upper:
        return handle_bearish(
            mode,
            pos_qty,
            pos_dir,
            f"波段做空：触及上轨 {float(upper):.2f}",
            _SNAP,
            snapshot,
            "band_upper",
        )

    if close > float(middle):
        zone = "中轨上方"
    elif close < float(middle):
        zone = "中轨下方"
    else:
        zone = "中轨附近"
    return signal_result(
        "hold",
        f"通道内观望（{zone}，{float(lower):.2f}~{float(upper):.2f}）",
        0.4,
        "none",
        _SNAP,
        snapshot,
    )
