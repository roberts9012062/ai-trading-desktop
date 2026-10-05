"""技术指标纯函数 —— 与前端 indicators.ts 算法对齐

用于 AI Agent calculate_indicator 工具。
仅计算序列数值，不访问网络/数据库。
"""

from __future__ import annotations

from typing import Any


def _round_f(value: float, digits: int) -> float:
    """按指定小数位四舍五入"""
    return round(value, digits)


def calc_sma(closes: list[float], period: int) -> list[float | None]:
    """简单移动平均。数据不足时对应位置为 None。"""
    if period <= 0:
        raise ValueError("period 必须为正整数")
    result: list[float | None] = [None] * len(closes)
    if len(closes) < period:
        return result
    window_sum = sum(closes[:period])
    result[period - 1] = window_sum / period
    for index in range(period, len(closes)):
        window_sum += closes[index] - closes[index - period]
        result[index] = window_sum / period
    return result


def calc_ema(closes: list[float], period: int) -> list[float | None]:
    """指数移动平均。首值用 SMA 作种子，与前端 calcEMA 一致。"""
    if period <= 0:
        raise ValueError("period 必须为正整数")
    result: list[float | None] = [None] * len(closes)
    if len(closes) < period:
        return result
    seed = sum(closes[:period]) / period
    result[period - 1] = seed
    k = 2.0 / (period + 1)
    for index in range(period, len(closes)):
        prev = result[index - 1]
        if prev is None:
            continue
        result[index] = closes[index] * k + prev * (1.0 - k)
    return result


def calc_macd(
    closes: list[float],
    fast_period: int,
    slow_period: int,
    signal_period: int,
) -> list[dict[str, float | None]]:
    """MACD：DIF/DEA/柱。柱值 = 2*(DIF-DEA)，与前端一致。"""
    ema_fast = calc_ema(closes, fast_period)
    ema_slow = calc_ema(closes, slow_period)
    dif_values: list[float | None] = []
    for index in range(len(closes)):
        fast = ema_fast[index]
        slow = ema_slow[index]
        if fast is None or slow is None:
            dif_values.append(None)
        else:
            dif_values.append(fast - slow)

    # DEA 仅对有效 DIF 段做 EMA；无效位填 0 参与序列索引对齐（同前端）
    dif_for_ema = [value if value is not None else 0.0 for value in dif_values]
    dea_values = calc_ema(dif_for_ema, signal_period)

    points: list[dict[str, float | None]] = []
    for index in range(len(closes)):
        dif = dif_values[index]
        dea = dea_values[index]
        if dif is None or dea is None:
            points.append({"dif": None, "dea": None, "macd": None})
            continue
        histogram = 2.0 * (dif - dea)
        points.append(
            {
                "dif": dif,
                "dea": dea,
                "macd": histogram,
            }
        )
    return points


def calc_rsi(closes: list[float], period: int) -> list[float | None]:
    """RSI（Wilder 平滑）。"""
    if period <= 0:
        raise ValueError("period 必须为正整数")
    result: list[float | None] = [None] * len(closes)
    if len(closes) <= period:
        return result

    gains = 0.0
    losses = 0.0
    for index in range(1, period + 1):
        delta = closes[index] - closes[index - 1]
        if delta >= 0:
            gains += delta
        else:
            losses -= delta
    avg_gain = gains / period
    avg_loss = losses / period
    if avg_loss == 0:
        result[period] = 100.0
    else:
        rs = avg_gain / avg_loss
        result[period] = _round_f(100.0 - (100.0 / (1.0 + rs)), 4)

    for index in range(period + 1, len(closes)):
        delta = closes[index] - closes[index - 1]
        gain = delta if delta > 0 else 0.0
        loss = -delta if delta < 0 else 0.0
        avg_gain = (avg_gain * (period - 1) + gain) / period
        avg_loss = (avg_loss * (period - 1) + loss) / period
        if avg_loss == 0:
            result[index] = 100.0
        else:
            rs = avg_gain / avg_loss
            result[index] = _round_f(100.0 - (100.0 / (1.0 + rs)), 4)
    return result


def calc_boll(
    closes: list[float],
    period: int,
    std_mult: float,
) -> list[dict[str, float | None]]:
    """布林带：中轨 SMA，上下轨 = 中轨 ± std_mult * 标准差。"""
    middle = calc_sma(closes, period)
    points: list[dict[str, float | None]] = []
    for index in range(len(closes)):
        mid = middle[index]
        if mid is None:
            points.append({"upper": None, "middle": None, "lower": None})
            continue
        window = closes[index - period + 1 : index + 1]
        mean = sum(window) / period
        variance = sum((value - mean) ** 2 for value in window) / period
        std = variance ** 0.5
        points.append(
            {
                "upper": mid + std_mult * std,
                "middle": mid,
                "lower": mid - std_mult * std,
            }
        )
    return points


def calc_kdj(
    highs: list[float],
    lows: list[float],
    closes: list[float],
    n_period: int,
    k_period: int,
    d_period: int,
) -> list[dict[str, float | None]]:
    """KDJ：RSV + K/D 平滑，J = 3K - 2D。"""
    length = len(closes)
    result: list[dict[str, float | None]] = [
        {"k": None, "d": None, "j": None} for _ in range(length)
    ]
    if length < n_period or n_period <= 0:
        return result

    k_value = 50.0
    d_value = 50.0
    for index in range(n_period - 1, length):
        window_high = max(highs[index - n_period + 1 : index + 1])
        window_low = min(lows[index - n_period + 1 : index + 1])
        if window_high == window_low:
            rsv = 50.0
        else:
            rsv = (closes[index] - window_low) / (window_high - window_low) * 100.0
        k_value = (k_value * (k_period - 1) + rsv) / k_period
        d_value = (d_value * (d_period - 1) + k_value) / d_period
        j_value = 3.0 * k_value - 2.0 * d_value
        result[index] = {
            "k": _round_f(k_value, 4),
            "d": _round_f(d_value, 4),
            "j": _round_f(j_value, 4),
        }
    return result


def extract_series_from_bars(
    bars: list[dict[str, Any]],
) -> tuple[list[str], list[float], list[float], list[float], list[float], list[int], list[int | None]]:
    """从 K 线 bars 抽取 time/OHLCV/OI 序列。"""
    times: list[str] = []
    opens: list[float] = []
    highs: list[float] = []
    lows: list[float] = []
    closes: list[float] = []
    volumes: list[int] = []
    open_interests: list[int | None] = []
    for bar in bars:
        times.append(str(bar.get("time", "")))
        opens.append(float(bar.get("open", 0)))
        highs.append(float(bar.get("high", 0)))
        lows.append(float(bar.get("low", 0)))
        closes.append(float(bar.get("close", 0)))
        volumes.append(int(bar.get("volume", 0) or 0))
        oi_raw = bar.get("open_interest")
        open_interests.append(int(oi_raw) if oi_raw not in (None, "") else None)
    return times, opens, highs, lows, closes, volumes, open_interests


def last_valid_points(
    times: list[str],
    values: list[Any],
    count: int,
) -> list[dict[str, Any]]:
    """取序列末尾 count 个有效点（跳过 None / 全 None dict）。"""
    points: list[dict[str, Any]] = []
    for index in range(len(times) - 1, -1, -1):
        value = values[index]
        if value is None:
            continue
        if isinstance(value, dict) and all(item is None for item in value.values()):
            continue
        if isinstance(value, dict):
            points.append({"time": times[index], **value})
        else:
            points.append({"time": times[index], "value": value})
        if len(points) >= count:
            break
    points.reverse()
    return points
