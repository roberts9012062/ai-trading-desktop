"""金叉/死叉类策略的共用仓位处理（开多、开空、反向先平）"""

from __future__ import annotations

from typing import Any


def signal_result(
    action: str,
    reason: str,
    confidence: float,
    signal: str,
    snapshot_key: str,
    snapshot: dict[str, Any] | None,
) -> dict[str, Any]:
    """统一信号返回结构"""
    out: dict[str, Any] = {
        "action": action,
        "quantity": 0,
        "reason": reason,
        "confidence": confidence,
        "signal": signal,
        "parse_ok": True,
    }
    out[snapshot_key] = snapshot
    return out


def handle_bullish(
    side_mode: str,
    pos_qty: int,
    pos_dir: str,
    open_reason: str,
    snapshot_key: str,
    snapshot: dict[str, Any],
    signal_prefix: str,
) -> dict[str, Any]:
    """看多信号：开多 / 平空 / 受 side_mode 限制"""
    if side_mode == "short_only":
        if pos_qty > 0 and pos_dir == "short":
            return signal_result(
                "close",
                "金叉：只做空模式下平空",
                0.75,
                f"{signal_prefix}_close_short",
                snapshot_key,
                snapshot,
            )
        return signal_result(
            "hold",
            "金叉：只做空模式不开多",
            0.6,
            f"{signal_prefix}_skip",
            snapshot_key,
            snapshot,
        )
    if pos_qty > 0 and pos_dir == "long":
        return signal_result(
            "hold",
            "金叉：已持多仓",
            0.7,
            f"{signal_prefix}_hold_long",
            snapshot_key,
            snapshot,
        )
    if pos_qty > 0 and pos_dir == "short":
        return signal_result(
            "close",
            "金叉：平空（下根可开多）",
            0.8,
            f"{signal_prefix}_close_short",
            snapshot_key,
            snapshot,
        )
    return signal_result(
        "open_long",
        open_reason,
        0.85,
        f"{signal_prefix}_open_long",
        snapshot_key,
        snapshot,
    )


def handle_bearish(
    side_mode: str,
    pos_qty: int,
    pos_dir: str,
    open_reason: str,
    snapshot_key: str,
    snapshot: dict[str, Any],
    signal_prefix: str,
) -> dict[str, Any]:
    """看空信号：开空 / 平多 / 受 side_mode 限制"""
    if side_mode == "long_only":
        if pos_qty > 0 and pos_dir == "long":
            return signal_result(
                "close",
                "死叉：只做多模式下平多",
                0.75,
                f"{signal_prefix}_close_long",
                snapshot_key,
                snapshot,
            )
        return signal_result(
            "hold",
            "死叉：只做多模式不开空",
            0.6,
            f"{signal_prefix}_skip",
            snapshot_key,
            snapshot,
        )
    if pos_qty > 0 and pos_dir == "short":
        return signal_result(
            "hold",
            "死叉：已持空仓",
            0.7,
            f"{signal_prefix}_hold_short",
            snapshot_key,
            snapshot,
        )
    if pos_qty > 0 and pos_dir == "long":
        return signal_result(
            "close",
            "死叉：平多（下根可开空）",
            0.8,
            f"{signal_prefix}_close_long",
            snapshot_key,
            snapshot,
        )
    return signal_result(
        "open_short",
        open_reason,
        0.85,
        f"{signal_prefix}_open_short",
        snapshot_key,
        snapshot,
    )


def position_qty_dir(
    position: dict[str, Any] | None,
) -> tuple[int, str]:
    """从持仓字典取可用数量与方向"""
    pos_qty = int(
        (position or {}).get("available_quantity")
        or (position or {}).get("quantity")
        or 0
    )
    pos_dir = str((position or {}).get("direction") or "")
    return pos_qty, pos_dir
