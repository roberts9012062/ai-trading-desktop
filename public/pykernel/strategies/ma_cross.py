"""双均线交叉量化策略 —— 纯规则信号，不调用 LLM

信号（基于已收盘 K 线）：
- 金叉：快线上穿慢线 → open_long（side_mode 允许时）
- 死叉：快线下穿慢线 → open_short（side_mode 允许时）
- 已有同向仓：hold；反向信号：先 close（由上层/风控配合）

strategy_params:
  fast_period: int  默认 5
  slow_period: int  默认 20
  ma_type: "sma" | "ema"  默认 sma
"""

from __future__ import annotations

from typing import Any

from calc import calc_ema, calc_sma


def normalize_ma_params(raw: dict[str, Any] | None) -> dict[str, Any]:
    """规范化并校验均线参数"""
    src = dict(raw or {})
    try:
        fast = int(src.get("fast_period") or 5)
    except (TypeError, ValueError):
        fast = 5
    try:
        slow = int(src.get("slow_period") or 20)
    except (TypeError, ValueError):
        slow = 20
    ma_type = str(src.get("ma_type") or "sma").strip().lower()
    if ma_type not in ("sma", "ema"):
        ma_type = "sma"
    if fast < 1:
        fast = 1
    if slow < 2:
        slow = 2
    if fast >= slow:
        # 保证快线更短
        fast, slow = min(fast, slow - 1), max(slow, fast + 1)
        if fast < 1:
            fast = 1
    return {
        "fast_period": fast,
        "slow_period": slow,
        "ma_type": ma_type,
    }


def _closes_from_bars(bars: list[dict[str, Any]]) -> list[float]:
    closes: list[float] = []
    for bar in bars:
        try:
            closes.append(float(bar.get("close") or 0))
        except (TypeError, ValueError):
            closes.append(0.0)
    return closes


def compute_ma_cross_signal(
    bars: list[dict[str, Any]],
    params: dict[str, Any],
    side_mode: str,
    position: dict[str, Any] | None,
) -> dict[str, Any]:
    """根据 K 线计算双均线交叉信号

    返回: {action, quantity, reason, confidence, signal, ma_snapshot}
    quantity 由上层风控再 cap；此处默认 0 表示交由仓位模式决定。
    """
    p = normalize_ma_params(params)
    fast_n = int(p["fast_period"])
    slow_n = int(p["slow_period"])
    ma_type = str(p["ma_type"])

    # 需要至少 slow+2 根（含 forming 时上层已取 closed）
    if len(bars) < slow_n + 1:
        return {
            "action": "hold",
            "quantity": 0,
            "reason": f"K线不足（需≥{slow_n + 1}根）",
            "confidence": 0,
            "signal": "insufficient_data",
            "ma_snapshot": None,
            "parse_ok": True,
        }

    closes = _closes_from_bars(bars)
    if ma_type == "ema":
        fast_series = calc_ema(closes, fast_n)
        slow_series = calc_ema(closes, slow_n)
    else:
        fast_series = calc_sma(closes, fast_n)
        slow_series = calc_sma(closes, slow_n)

    i = len(closes) - 1
    prev = i - 1
    if prev < 0:
        return {
            "action": "hold",
            "quantity": 0,
            "reason": "有效K线不足",
            "confidence": 0,
            "signal": "insufficient_data",
            "ma_snapshot": None,
            "parse_ok": True,
        }

    f0, f1 = fast_series[prev], fast_series[i]
    s0, s1 = slow_series[prev], slow_series[i]
    if None in (f0, f1, s0, s1):
        return {
            "action": "hold",
            "quantity": 0,
            "reason": "均线尚未形成",
            "confidence": 0,
            "signal": "ma_not_ready",
            "ma_snapshot": None,
            "parse_ok": True,
        }

    snapshot = {
        "fast_period": fast_n,
        "slow_period": slow_n,
        "ma_type": ma_type,
        "fast_prev": round(float(f0), 4),
        "fast_now": round(float(f1), 4),
        "slow_prev": round(float(s0), 4),
        "slow_now": round(float(s1), 4),
        "close": closes[i],
    }

    golden = float(f0) <= float(s0) and float(f1) > float(s1)
    death = float(f0) >= float(s0) and float(f1) < float(s1)

    pos_qty = int(
        (position or {}).get("available_quantity")
        or (position or {}).get("quantity")
        or 0
    )
    pos_dir = str((position or {}).get("direction") or "")
    mode = (side_mode or "both").strip().lower()

    if golden:
        return _handle_golden(mode, pos_qty, pos_dir, snapshot)
    if death:
        return _handle_death(mode, pos_qty, pos_dir, snapshot)

    # 无交叉：趋势持有提示
    if float(f1) > float(s1):
        trend = "多头排列"
    elif float(f1) < float(s1):
        trend = "空头排列"
    else:
        trend = "均线粘合"
    return {
        "action": "hold",
        "quantity": 0,
        "reason": f"无交叉信号（{trend}）",
        "confidence": 0.4,
        "signal": "none",
        "ma_snapshot": snapshot,
        "parse_ok": True,
    }


def _handle_golden(
    side_mode: str,
    pos_qty: int,
    pos_dir: str,
    snapshot: dict[str, Any],
) -> dict[str, Any]:
    """金叉处理"""
    if side_mode == "short_only":
        # 只做空：金叉时若有空仓则平空
        if pos_qty > 0 and pos_dir == "short":
            return {
                "action": "close",
                "quantity": 0,
                "reason": "金叉：只做空模式下平空",
                "confidence": 0.75,
                "signal": "golden_close_short",
                "ma_snapshot": snapshot,
                "parse_ok": True,
            }
        return {
            "action": "hold",
            "quantity": 0,
            "reason": "金叉：只做空模式不开多",
            "confidence": 0.6,
            "signal": "golden_skip",
            "ma_snapshot": snapshot,
            "parse_ok": True,
        }
    if pos_qty > 0 and pos_dir == "long":
        return {
            "action": "hold",
            "quantity": 0,
            "reason": "金叉：已持多仓",
            "confidence": 0.7,
            "signal": "golden_hold_long",
            "ma_snapshot": snapshot,
            "parse_ok": True,
        }
    if pos_qty > 0 and pos_dir == "short":
        # 先平空，下根再开多（简化：本 bar 平仓）
        return {
            "action": "close",
            "quantity": 0,
            "reason": "金叉：平空（下根可开多）",
            "confidence": 0.8,
            "signal": "golden_close_short",
            "ma_snapshot": snapshot,
            "parse_ok": True,
        }
    return {
        "action": "open_long",
        "quantity": 0,
        "reason": f"金叉开多 MA{snapshot['fast_period']}/{snapshot['slow_period']}",
        "confidence": 0.85,
        "signal": "golden_open_long",
        "ma_snapshot": snapshot,
        "parse_ok": True,
    }


def _handle_death(
    side_mode: str,
    pos_qty: int,
    pos_dir: str,
    snapshot: dict[str, Any],
) -> dict[str, Any]:
    """死叉处理"""
    if side_mode == "long_only":
        if pos_qty > 0 and pos_dir == "long":
            return {
                "action": "close",
                "quantity": 0,
                "reason": "死叉：只做多模式下平多",
                "confidence": 0.75,
                "signal": "death_close_long",
                "ma_snapshot": snapshot,
                "parse_ok": True,
            }
        return {
            "action": "hold",
            "quantity": 0,
            "reason": "死叉：只做多模式不开空",
            "confidence": 0.6,
            "signal": "death_skip",
            "ma_snapshot": snapshot,
            "parse_ok": True,
        }
    if pos_qty > 0 and pos_dir == "short":
        return {
            "action": "hold",
            "quantity": 0,
            "reason": "死叉：已持空仓",
            "confidence": 0.7,
            "signal": "death_hold_short",
            "ma_snapshot": snapshot,
            "parse_ok": True,
        }
    if pos_qty > 0 and pos_dir == "long":
        return {
            "action": "close",
            "quantity": 0,
            "reason": "死叉：平多（下根可开空）",
            "confidence": 0.8,
            "signal": "death_close_long",
            "ma_snapshot": snapshot,
            "parse_ok": True,
        }
    return {
        "action": "open_short",
        "quantity": 0,
        "reason": f"死叉开空 MA{snapshot['fast_period']}/{snapshot['slow_period']}",
        "confidence": 0.85,
        "signal": "death_open_short",
        "ma_snapshot": snapshot,
        "parse_ok": True,
    }
