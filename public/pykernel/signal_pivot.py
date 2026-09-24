"""波段枢轴信号 —— 与前端 lib/pivot-signals.ts 对齐

波谷做多、波峰做空；left/right=3；幅度过滤默认 1.5% / 1.5×ATR。
"""

from __future__ import annotations

from typing import Any, TypedDict


class PivotPoint(TypedDict):
    """枢轴信号点"""

    time: str
    side: str  # long | short
    price: float
    index: int
    provisional: bool


def calc_atr(klines: list[dict[str, Any]], period: int) -> list[float | None]:
    """Wilder ATR，与前端一致。"""
    n = len(klines)
    out: list[float | None] = [None] * n
    if period <= 0 or n < period + 1:
        return out

    tr: list[float] = [0.0] * n
    tr[0] = float(klines[0]["high"]) - float(klines[0]["low"])
    for i in range(1, n):
        h = float(klines[i]["high"])
        l = float(klines[i]["low"])
        pc = float(klines[i - 1]["close"])
        tr[i] = max(h - l, abs(h - pc), abs(l - pc))

    total = sum(tr[1 : period + 1])
    atr = total / period
    out[period] = atr
    for i in range(period + 1, n):
        atr = (atr * (period - 1) + tr[i]) / period
        out[i] = atr
    return out


def _is_pivot_at(
    klines: list[dict[str, Any]],
    i: int,
    left: int,
    right_count: int,
) -> tuple[bool, bool]:
    """分型峰谷判定。"""
    hi = float(klines[i]["high"])
    lo = float(klines[i]["low"])
    is_high = True
    is_low = True
    for j in range(1, left + 1):
        if float(klines[i - j]["high"]) > hi:
            is_high = False
        if float(klines[i - j]["low"]) < lo:
            is_low = False
        if not is_high and not is_low:
            return False, False
    for j in range(1, right_count + 1):
        if float(klines[i + j]["high"]) >= hi:
            is_high = False
        if float(klines[i + j]["low"]) <= lo:
            is_low = False
        if not is_high and not is_low:
            break
    return is_high, is_low


def calc_pivot_signals(
    klines: list[dict[str, Any]],
    left: int = 3,
    right: int = 3,
    *,
    alternate: bool = True,
    min_amplitude_pct: float = 1.5,
    min_atr_mult: float = 1.5,
    atr_period: int = 14,
    min_right_live: int = 1,
) -> list[PivotPoint]:
    """计算枢轴信号列表（与前端 calcPivotSignals 同逻辑）。"""
    n = len(klines)
    if left < 1 or right < 1 or n < left + 2:
        return []

    min_right = max(1, min(right, int(min_right_live or 1)))
    raw: list[PivotPoint] = []

    for i in range(left, n - min_right):
        avail_right = n - 1 - i
        if avail_right < min_right:
            continue
        right_count = min(right, avail_right)
        is_high, is_low = _is_pivot_at(klines, i, left, right_count)
        if is_high and is_low:
            continue
        if not is_high and not is_low:
            continue
        provisional = right_count < right
        if is_high:
            raw.append(
                {
                    "time": str(klines[i].get("time") or ""),
                    "side": "short",
                    "price": float(klines[i]["high"]),
                    "index": i,
                    "provisional": provisional,
                }
            )
        else:
            raw.append(
                {
                    "time": str(klines[i].get("time") or ""),
                    "side": "long",
                    "price": float(klines[i]["low"]),
                    "index": i,
                    "provisional": provisional,
                }
            )

    if not raw:
        return raw

    seq = raw
    if alternate:
        alt: list[PivotPoint] = [raw[0]]
        for cur in raw[1:]:
            prev = alt[-1]
            if cur["side"] == prev["side"]:
                if cur["side"] == "long" and cur["price"] < prev["price"]:
                    alt[-1] = cur
                elif cur["side"] == "short" and cur["price"] > prev["price"]:
                    alt[-1] = cur
            else:
                alt.append(cur)
        seq = alt

    min_pct = max(0.0, min_amplitude_pct)
    min_atr = max(0.0, min_atr_mult)
    if min_pct <= 0 and min_atr <= 0:
        return seq

    atr_arr = calc_atr(klines, max(1, atr_period)) if min_atr > 0 else None
    out: list[PivotPoint] = [seq[0]]
    for cur in seq[1:]:
        prev = out[-1]
        if cur["side"] == prev["side"]:
            if cur["side"] == "long" and cur["price"] < prev["price"]:
                out[-1] = cur
            elif cur["side"] == "short" and cur["price"] > prev["price"]:
                out[-1] = cur
            continue
        move = abs(cur["price"] - prev["price"])
        thr_pct = (
            (abs(prev["price"]) * min_pct) / 100.0
            if min_pct > 0 and prev["price"] > 0
            else 0.0
        )
        thr_atr = 0.0
        if atr_arr is not None and min_atr > 0:
            a = atr_arr[cur["index"]]
            if a is None:
                a = atr_arr[prev["index"]]
            if a is not None and a > 0:
                thr_atr = a * min_atr
        thr = max(thr_pct, thr_atr)
        if thr <= 0 or move >= thr:
            out.append(cur)
    return out


def pivot_on_bar(
    klines: list[dict[str, Any]],
    bar_index: int,
) -> PivotPoint | None:
    """若 bar_index 这根 K 上有图表多/空标注，返回该枢轴点。"""
    if bar_index < 0 or bar_index >= len(klines):
        return None
    signals = calc_pivot_signals(klines)
    # 取落在该 bar 上的信号（同 index 只应一个）
    for sig in reversed(signals):
        if sig["index"] == bar_index:
            return sig
    return None
