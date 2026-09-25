"""N 日突破（Donchian 通道）量化策略 —— 纯规则，不调用 LLM

信号（基于已收盘 K 线，通道用「当前 bar 之前」的 N 根）：
- 收盘价 > 前 N 根最高价 → 向上突破 → open_long
- 收盘价 < 前 N 根最低价 → 向下突破 → open_short
- 已有同向仓：hold；反向信号：先 close

strategy_params:
  lookback: int  突破回看周期，默认 20
  price_field: "close"  比较字段，目前固定 close 突破 high/low 通道
"""

from __future__ import annotations

from typing import Any


def normalize_breakout_params(raw: dict[str, Any] | None) -> dict[str, Any]:
    """规范化 N 日突破参数"""
    src = dict(raw or {})
    try:
        lookback = int(src.get("lookback") or src.get("lookback_period") or 20)
    except (TypeError, ValueError):
        lookback = 20
    if lookback < 2:
        lookback = 2
    if lookback > 500:
        lookback = 500
    return {"lookback": lookback}


def _f(bar: dict[str, Any], key: str) -> float:
    try:
        return float(bar.get(key) or 0)
    except (TypeError, ValueError):
        return 0.0


def compute_n_breakout_signal(
    bars: list[dict[str, Any]],
    params: dict[str, Any],
    side_mode: str,
    position: dict[str, Any] | None,
) -> dict[str, Any]:
    """根据 K 线计算 N 日突破信号

    bars 末根应为当前已收盘 bar。
    返回结构与 ma_cross 一致，便于 engine 统一处理。
    """
    p = normalize_breakout_params(params)
    n = int(p["lookback"])

    # 需要 N 根历史 + 当前 1 根
    if len(bars) < n + 1:
        return {
            "action": "hold",
            "quantity": 0,
            "reason": f"K线不足（需≥{n + 1}根）",
            "confidence": 0,
            "signal": "insufficient_data",
            "breakout_snapshot": None,
            "parse_ok": True,
        }

    curr = bars[-1]
    hist = bars[-(n + 1) : -1]
    if len(hist) < n:
        return {
            "action": "hold",
            "quantity": 0,
            "reason": "历史窗口不足",
            "confidence": 0,
            "signal": "insufficient_data",
            "breakout_snapshot": None,
            "parse_ok": True,
        }

    upper = max(_f(b, "high") for b in hist)
    lower = min(_f(b, "low") for b in hist)
    # high/low 缺失时回退 close
    if upper <= 0:
        upper = max(_f(b, "close") for b in hist)
    if lower <= 0:
        lower = min(_f(b, "close") for b in hist)

    close = _f(curr, "close")
    snapshot = {
        "lookback": n,
        "upper": round(upper, 4),
        "lower": round(lower, 4),
        "close": round(close, 4),
        "bar_time": curr.get("time"),
    }

    up_break = close > upper
    down_break = close < lower

    pos_qty = int(
        (position or {}).get("available_quantity")
        or (position or {}).get("quantity")
        or 0
    )
    pos_dir = str((position or {}).get("direction") or "")
    mode = (side_mode or "both").strip().lower()

    if up_break:
        return _handle_up(mode, pos_qty, pos_dir, snapshot)
    if down_break:
        return _handle_down(mode, pos_qty, pos_dir, snapshot)

    # 通道内
    if close >= upper:
        loc = "贴近上轨"
    elif close <= lower:
        loc = "贴近下轨"
    else:
        loc = "通道内"
    return {
        "action": "hold",
        "quantity": 0,
        "reason": f"无突破（{loc}，通道 {lower:.2f}~{upper:.2f}）",
        "confidence": 0.4,
        "signal": "none",
        "breakout_snapshot": snapshot,
        "parse_ok": True,
    }


def _handle_up(
    side_mode: str,
    pos_qty: int,
    pos_dir: str,
    snapshot: dict[str, Any],
) -> dict[str, Any]:
    """向上突破"""
    n = snapshot["lookback"]
    if side_mode == "short_only":
        if pos_qty > 0 and pos_dir == "short":
            return {
                "action": "close",
                "quantity": 0,
                "reason": f"向上突破{n}日：只做空模式下平空",
                "confidence": 0.75,
                "signal": "up_close_short",
                "breakout_snapshot": snapshot,
                "parse_ok": True,
            }
        return {
            "action": "hold",
            "quantity": 0,
            "reason": f"向上突破{n}日：只做空模式不开多",
            "confidence": 0.6,
            "signal": "up_skip",
            "breakout_snapshot": snapshot,
            "parse_ok": True,
        }
    if pos_qty > 0 and pos_dir == "long":
        return {
            "action": "hold",
            "quantity": 0,
            "reason": f"向上突破{n}日：已持多仓",
            "confidence": 0.7,
            "signal": "up_hold_long",
            "breakout_snapshot": snapshot,
            "parse_ok": True,
        }
    if pos_qty > 0 and pos_dir == "short":
        return {
            "action": "close",
            "quantity": 0,
            "reason": f"向上突破{n}日：平空（下根可开多）",
            "confidence": 0.8,
            "signal": "up_close_short",
            "breakout_snapshot": snapshot,
            "parse_ok": True,
        }
    return {
        "action": "open_long",
        "quantity": 0,
        "reason": f"向上突破{n}日高点 {snapshot['upper']} 开多",
        "confidence": 0.85,
        "signal": "up_open_long",
        "breakout_snapshot": snapshot,
        "parse_ok": True,
    }


def _handle_down(
    side_mode: str,
    pos_qty: int,
    pos_dir: str,
    snapshot: dict[str, Any],
) -> dict[str, Any]:
    """向下突破"""
    n = snapshot["lookback"]
    if side_mode == "long_only":
        if pos_qty > 0 and pos_dir == "long":
            return {
                "action": "close",
                "quantity": 0,
                "reason": f"向下突破{n}日：只做多模式下平多",
                "confidence": 0.75,
                "signal": "down_close_long",
                "breakout_snapshot": snapshot,
                "parse_ok": True,
            }
        return {
            "action": "hold",
            "quantity": 0,
            "reason": f"向下突破{n}日：只做多模式不开空",
            "confidence": 0.6,
            "signal": "down_skip",
            "breakout_snapshot": snapshot,
            "parse_ok": True,
        }
    if pos_qty > 0 and pos_dir == "short":
        return {
            "action": "hold",
            "quantity": 0,
            "reason": f"向下突破{n}日：已持空仓",
            "confidence": 0.7,
            "signal": "down_hold_short",
            "breakout_snapshot": snapshot,
            "parse_ok": True,
        }
    if pos_qty > 0 and pos_dir == "long":
        return {
            "action": "close",
            "quantity": 0,
            "reason": f"向下突破{n}日：平多（下根可开空）",
            "confidence": 0.8,
            "signal": "down_close_long",
            "breakout_snapshot": snapshot,
            "parse_ok": True,
        }
    return {
        "action": "open_short",
        "quantity": 0,
        "reason": f"向下突破{n}日低点 {snapshot['lower']} 开空",
        "confidence": 0.85,
        "signal": "down_open_short",
        "breakout_snapshot": snapshot,
        "parse_ok": True,
    }
