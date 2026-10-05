"""方向信号的共用仓位处理（开多、开空、反向先平）"""

from __future__ import annotations

from typing import Any


def direction_signal_label(snapshot_key: str, snapshot: dict[str, Any], bullish: bool) -> str:
    if snapshot_key in ("macd_snapshot", "kdj_snapshot"):
        return "金叉" if bullish else "死叉"
    if snapshot_key == "swing_snapshot":
        label = "枢轴波谷反转做多信号" if bullish else "枢轴波峰反转做空信号"
        pivot = snapshot.get("last_pivot") or {}
        if pivot.get("provisional"):
            label += "（预确认）"
        elif pivot:
            label += "（正式确认）"
        return label
    return "看多信号" if bullish else "看空信号"


def display_position_reason(reason: str, output: dict[str, Any] | None) -> str:
    """Correct verified historical pivot labels when reading, preserving audit rows."""
    if not isinstance(output, dict):
        return reason
    signal = str(output.get("signal") or "")
    snapshot = output.get("swing_snapshot")
    if not isinstance(snapshot, dict):
        return reason
    if signal.startswith("swing_valley_") and reason.startswith("金叉："):
        return direction_signal_label("swing_snapshot", snapshot, True) + reason[2:]
    if signal.startswith("swing_peak_") and reason.startswith("死叉："):
        return direction_signal_label("swing_snapshot", snapshot, False) + reason[2:]
    return reason


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
    label = direction_signal_label(snapshot_key, snapshot, True)
    if side_mode == "short_only":
        if pos_qty > 0 and pos_dir == "short":
            return signal_result(
                "close",
                f"{label}：只做空模式下平空",
                0.75,
                f"{signal_prefix}_close_short",
                snapshot_key,
                snapshot,
            )
        return signal_result(
            "hold",
            f"{label}：只做空模式不开多",
            0.6,
            f"{signal_prefix}_skip",
            snapshot_key,
            snapshot,
        )
    if pos_qty > 0 and pos_dir == "long":
        return signal_result(
            "hold",
            f"{label}：已持多仓",
            0.7,
            f"{signal_prefix}_hold_long",
            snapshot_key,
            snapshot,
        )
    if pos_qty > 0 and pos_dir == "short":
        return signal_result(
            "close",
            f"{label}：平空（下根可开多）",
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
    label = direction_signal_label(snapshot_key, snapshot, False)
    if side_mode == "long_only":
        if pos_qty > 0 and pos_dir == "long":
            return signal_result(
                "close",
                f"{label}：只做多模式下平多",
                0.75,
                f"{signal_prefix}_close_long",
                snapshot_key,
                snapshot,
            )
        return signal_result(
            "hold",
            f"{label}：只做多模式不开空",
            0.6,
            f"{signal_prefix}_skip",
            snapshot_key,
            snapshot,
        )
    if pos_qty > 0 and pos_dir == "short":
        return signal_result(
            "hold",
            f"{label}：已持空仓",
            0.7,
            f"{signal_prefix}_hold_short",
            snapshot_key,
            snapshot,
        )
    if pos_qty > 0 and pos_dir == "long":
        return signal_result(
            "close",
            f"{label}：平多（下根可开空）",
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
) -> tuple[float, str]:
    """从持仓字典取可用数量与方向

    加密货币数量为小数基础币（如 0.369 ETH），必须 float——
    int 截断会把小数量持仓当 0，导致策略层当成无持仓重复开反向仓。
    """
    pos_qty = float(
        (position or {}).get("available_quantity")
        or (position or {}).get("quantity")
        or 0
    )
    pos_dir = str((position or {}).get("direction") or "")
    return pos_qty, pos_dir
