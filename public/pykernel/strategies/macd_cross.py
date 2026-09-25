"""MACD 金叉死叉量化策略 —— 纯规则，不调用 LLM

信号（已收盘 K 线）：
- DIF 上穿 DEA → 金叉 → open_long
- DIF 下穿 DEA → 死叉 → open_short
- 已有同向仓 hold；反向信号先 close

strategy_params:
  fast_period: int  默认 12
  slow_period: int  默认 26
  signal_period: int  默认 9
"""

from __future__ import annotations

from typing import Any

from calc import calc_macd
from strategies.position_handlers import (
    handle_bearish,
    handle_bullish,
    position_qty_dir,
    signal_result,
)

_SNAP = "macd_snapshot"


def normalize_macd_params(raw: dict[str, Any] | None) -> dict[str, Any]:
    """规范化 MACD 参数"""
    src = dict(raw or {})

    def _i(key: str, default: int, lo: int, hi: int) -> int:
        try:
            value = int(src.get(key) or default)
        except (TypeError, ValueError):
            value = default
        return max(lo, min(hi, value))

    fast = _i("fast_period", 12, 2, 100)
    slow = _i("slow_period", 26, 3, 200)
    signal = _i("signal_period", 9, 2, 100)
    if fast >= slow:
        fast, slow = min(fast, slow - 1), max(slow, fast + 1)
        if fast < 2:
            fast = 2
    return {
        "fast_period": fast,
        "slow_period": slow,
        "signal_period": signal,
    }


def _closes(bars: list[dict[str, Any]]) -> list[float]:
    out: list[float] = []
    for bar in bars:
        try:
            out.append(float(bar.get("close") or 0))
        except (TypeError, ValueError):
            out.append(0.0)
    return out


def compute_macd_cross_signal(
    bars: list[dict[str, Any]],
    params: dict[str, Any],
    side_mode: str,
    position: dict[str, Any] | None,
) -> dict[str, Any]:
    """MACD DIF/DEA 金叉死叉信号"""
    p = normalize_macd_params(params)
    fast_n = int(p["fast_period"])
    slow_n = int(p["slow_period"])
    sig_n = int(p["signal_period"])
    need = slow_n + sig_n + 2
    if len(bars) < need:
        return signal_result(
            "hold",
            f"K线不足（需≥{need}根）",
            0,
            "insufficient_data",
            _SNAP,
            None,
        )

    points = calc_macd(_closes(bars), fast_n, slow_n, sig_n)
    i = len(points) - 1
    prev = i - 1
    if prev < 0:
        return signal_result(
            "hold", "有效K线不足", 0, "insufficient_data", _SNAP, None
        )

    d0, e0 = points[prev].get("dif"), points[prev].get("dea")
    d1, e1 = points[i].get("dif"), points[i].get("dea")
    if None in (d0, e0, d1, e1):
        return signal_result(
            "hold", "MACD 尚未形成", 0, "macd_not_ready", _SNAP, None
        )

    snapshot = {
        "fast_period": fast_n,
        "slow_period": slow_n,
        "signal_period": sig_n,
        "dif_prev": float(d0),
        "dea_prev": float(e0),
        "dif_now": float(d1),
        "dea_now": float(e1),
        "hist_now": points[i].get("macd"),
    }
    golden = float(d0) <= float(e0) and float(d1) > float(e1)
    death = float(d0) >= float(e0) and float(d1) < float(e1)
    pos_qty, pos_dir = position_qty_dir(position)
    mode = (side_mode or "both").strip().lower()

    if golden:
        return handle_bullish(
            mode,
            pos_qty,
            pos_dir,
            f"MACD金叉开多 DIF上穿DEA ({fast_n}/{slow_n}/{sig_n})",
            _SNAP,
            snapshot,
            "macd_golden",
        )
    if death:
        return handle_bearish(
            mode,
            pos_qty,
            pos_dir,
            f"MACD死叉开空 DIF下穿DEA ({fast_n}/{slow_n}/{sig_n})",
            _SNAP,
            snapshot,
            "macd_death",
        )

    if float(d1) > float(e1):
        trend = "DIF>DEA 多头"
    elif float(d1) < float(e1):
        trend = "DIF<DEA 空头"
    else:
        trend = "DIF≈DEA"
    return signal_result(
        "hold",
        f"无交叉信号（{trend}）",
        0.4,
        "none",
        _SNAP,
        snapshot,
    )
