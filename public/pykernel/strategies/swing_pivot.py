"""枢轴波段策略 —— 价格高低点 Fractal 反转，纯规则

与前端图表「波段信号」同口径（复用 signal_pivot.calc_pivot_signals），
波谷反转做多、波峰反转做空。

信号（已收盘 K 线）：
- 最新枢轴为波谷（long）→ 反转做多（open_long）
- 最新枢轴为波峰（short）→ 反转做空（open_short）
- 盘中预确认（min_right_live < right，provisional=True）同样触发交易，
  与图表「盘中预确认」箭头一致；预确认信号会随行情破坏而消失，
  该风险由参数选择承担（设为 right 则只出正式确认）
- 新鲜度窗口 last_idx - last["index"] <= right 视为有效新信号
- 已有同向仓 hold；反向信号先 close（由 handle_bullish/handle_bearish 完成）

strategy_params:
  left: int            左侧分型根数，默认 3
  right: int           右侧确认根数（正式），默认 3，下限 2（对齐图表波段信号）
  min_right_live: int  盘中预确认最少右侧根数，1–right；未传默认 = right（只出正式确认，
                       兼容旧任务）；新建任务由前端显式传 1（对齐图表默认）
  min_amplitude_pct: float  最小幅度百分比过滤，默认 1.5
  min_atr_mult: float  最小 ATR 倍数过滤，默认 1.5
  atr_period: int      ATR 计算周期，默认 14
"""

from __future__ import annotations

from typing import Any

from strategies.position_handlers import (
    handle_bearish,
    handle_bullish,
    position_qty_dir,
    signal_result,
)
from signal_pivot import calc_pivot_signals

_SNAP = "swing_snapshot"


def normalize_swing_pivot_params(raw: dict[str, Any] | None) -> dict[str, Any]:
    """规范化枢轴波段参数并 clamp 到安全区间"""
    src = dict(raw or {})

    def _as_int(key: str, aliases: tuple[str, ...], default: int) -> int:
        for name in (key, *aliases):
            val = src.get(name)
            if val is None:
                continue
            try:
                return int(val)
            except (TypeError, ValueError):
                return default
        return default

    def _as_float(key: str, aliases: tuple[str, ...], default: float) -> float:
        for name in (key, *aliases):
            val = src.get(name)
            if val is None:
                continue
            try:
                return float(val)
            except (TypeError, ValueError):
                return default
        return default

    left = max(1, min(20, _as_int("left", ("left_bars",), 3)))
    # right 下限 2：对齐图表波段信号 indicator.py 的 ge=2，1 根确认不稳健
    right = max(2, min(20, _as_int("right", ("right_bars",), 3)))
    # min_right_live：盘中预确认最少右侧根数，1–right；未传默认 = right（只出正式确认）
    min_right_live = max(1, min(right, _as_int("min_right_live", (), right)))
    min_amplitude_pct = max(0.0, min(20.0, _as_float("min_amplitude_pct", (), 1.5)))
    min_atr_mult = max(0.0, min(10.0, _as_float("min_atr_mult", (), 1.5)))
    atr_period = max(1, min(100, _as_int("atr_period", (), 14)))
    return {
        "left": left,
        "right": right,
        "min_right_live": min_right_live,
        "min_amplitude_pct": min_amplitude_pct,
        "min_atr_mult": min_atr_mult,
        "atr_period": atr_period,
    }


def _latest_confirmed_pivot(
    bars: list[dict[str, Any]],
    p: dict[str, Any],
) -> tuple[dict[str, Any] | None, int]:
    """取最新枢轴点（按 min_right_live 出预确认/正式确认信号）。

    返回 (pivot_point, last_index)。pivot_point 为 None 表示无枢轴。
    min_right_live < right 时右侧凑满 min_right_live 即出预确认
    （provisional=True）；= right 时只出正式确认（provisional=False）。
    """
    left = int(p["left"])
    right = int(p["right"])
    min_right_live = int(p["min_right_live"])
    min_amp = float(p["min_amplitude_pct"])
    min_atr = float(p["min_atr_mult"])
    atr_period = int(p["atr_period"])
    n = len(bars)
    # 至少需要 left + 2 根才能形成枢轴（calc_pivot_signals 内部约束）
    if left < 1 or right < 1 or n < left + 2:
        return None, max(0, n - 1)
    signals = calc_pivot_signals(
        bars,
        left=left,
        right=right,
        alternate=True,
        min_amplitude_pct=min_amp,
        min_atr_mult=min_atr,
        atr_period=atr_period,
        min_right_live=min_right_live,
    )
    if not signals:
        return None, max(0, n - 1)
    return signals[-1], max(0, n - 1)


def compute_swing_pivot_signal(
    bars: list[dict[str, Any]],
    params: dict[str, Any],
    side_mode: str,
    position: dict[str, Any] | None,
) -> dict[str, Any]:
    """根据 K 线计算枢轴波段反转信号

    bars 末根应为当前已收盘 bar。
    返回 signal_result 统一结构，快照键 swing_snapshot。
    """
    p = normalize_swing_pivot_params(params)
    left = int(p["left"])
    right = int(p["right"])
    min_right_live = int(p["min_right_live"])

    if len(bars) < left + 2:
        return signal_result(
            "hold",
            f"K线不足（需≥{left + 2}根）",
            0,
            "insufficient_data",
            _SNAP,
            None,
        )

    pivot, last_idx = _latest_confirmed_pivot(bars, p)
    # 基线快照：参数 + 当前 bar 收盘 + 最新枢轴状态
    close = float(bars[-1].get("close") or 0)
    snapshot: dict[str, Any] = {
        "left": left,
        "right": right,
        "min_right_live": min_right_live,
        "min_amplitude_pct": float(p["min_amplitude_pct"]),
        "min_atr_mult": float(p["min_atr_mult"]),
        "atr_period": int(p["atr_period"]),
        "close": close,
        "bar_time": bars[-1].get("time"),
        "last_pivot": None,
        "freshness": None,
    }

    if pivot is None:
        snapshot["last_pivot"] = None
        return signal_result(
            "hold",
            "尚未形成枢轴波段",
            0.3,
            "none",
            _SNAP,
            snapshot,
        )

    pivot_idx = int(pivot.get("index") or 0)
    pivot_side = str(pivot.get("side") or "")
    pivot_price = float(pivot.get("price") or 0)
    is_provisional = bool(pivot.get("provisional"))
    freshness = last_idx - pivot_idx
    snapshot["last_pivot"] = {
        "side": pivot_side,
        "price": pivot_price,
        "index": pivot_idx,
        "time": pivot.get("time"),
        "provisional": is_provisional,
    }
    snapshot["freshness"] = freshness

    # 新鲜度窗口：枢轴须在最近 right 根的确认窗口内（预确认 freshness < right 恒通过）
    if freshness > right:
        return signal_result(
            "hold",
            f"无新枢轴（最近{freshness}根前的{('波峰' if pivot_side == 'short' else '波谷')}，已过确认窗口）",
            0.35,
            "stale",
            _SNAP,
            snapshot,
        )

    # 盘中预确认：右侧已 ≥ min_right_live 但未凑满 right 根的枢轴同样触发交易，
    # 与图表「盘中预确认」箭头同口径（min_right_live=right 时不会产出 provisional，
    # 此处为防御性兜底）。预确认信号会随行情破坏消失，由快照 provisional 标记区分。
    pos_qty, pos_dir = position_qty_dir(position)
    mode = (side_mode or "both").strip().lower()

    if pivot_side == "long":
        if is_provisional:
            return handle_bullish(
                mode,
                pos_qty,
                pos_dir,
                f"枢轴波谷反转做多（预确认，右侧仅{freshness}根）@ {pivot_price:.2f}",
                _SNAP,
                snapshot,
                "swing_valley",
            )
        return handle_bullish(
            mode,
            pos_qty,
            pos_dir,
            f"枢轴波谷反转做多 @ {pivot_price:.2f}",
            _SNAP,
            snapshot,
            "swing_valley",
        )
    if pivot_side == "short":
        if is_provisional:
            return handle_bearish(
                mode,
                pos_qty,
                pos_dir,
                f"枢轴波峰反转做空（预确认，右侧仅{freshness}根）@ {pivot_price:.2f}",
                _SNAP,
                snapshot,
                "swing_peak",
            )
        return handle_bearish(
            mode,
            pos_qty,
            pos_dir,
            f"枢轴波峰反转做空 @ {pivot_price:.2f}",
            _SNAP,
            snapshot,
            "swing_peak",
        )
    # 理论不可达（side 仅 long/short），兜底
    return signal_result(
        "hold",
        "枢轴方向未知",
        0.3,
        "unknown",
        _SNAP,
        snapshot,
    )
