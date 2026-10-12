"""Two price-scale independent TA candidates; old feature arithmetic is frozen.

MACD uses SMA-seeded EMA and the chart's 2*(DIF-DEA) convention.
KDJ uses RSV(9), recursive K/D(3), initial K=D=first RSV, J=3K-2D.
Unavailable warmup remains NaN. Normalization is causal with a fixed 200 bars.
"""
from __future__ import annotations

import numpy as np


def chart_ema(values: np.ndarray, period: int) -> np.ndarray:
    out = np.full(len(values), np.nan)
    if len(values) < period:
        return out
    out[period - 1] = float(sum(values[:period])) / period
    alpha = 2.0 / (period + 1.0)
    for i in range(period, len(values)):
        out[i] = values[i] * alpha + out[i - 1] * (1.0 - alpha)
    return out


def technical_raw(bars: list[dict]) -> dict[str, np.ndarray]:
    close, high, low = (np.array([float(b[k]) for b in bars]) for k in ("close", "high", "low"))
    if not all(np.isfinite(x).all() for x in (close, high, low)) or np.any(close <= 0):
        raise ValueError("Technical factors require finite OHLC and positive closes")
    dif = chart_ema(close, 12) - chart_ema(close, 26)
    dea = chart_ema(np.where(np.isfinite(dif), dif, 0.0), 9)
    histogram = 2.0 * (dif - dea) / np.maximum(np.abs(close), 1e-9)
    j = np.full(len(close), np.nan)
    previous_k = previous_d = 50.0
    for i in range(8, len(close)):
        hh, ll = float(np.max(high[i - 8:i + 1])), float(np.min(low[i - 8:i + 1]))
        rsv = 50.0 if hh == ll else (close[i] - ll) / (hh - ll) * 100.0
        k = rsv if i == 8 else (1.0 - 1.0 / 3.0) * previous_k + rsv / 3.0
        d = k if i == 8 else (1.0 - 1.0 / 3.0) * previous_d + k / 3.0
        j[i] = (3.0 * k - 2.0 * d - 50.0) / 50.0
        previous_k, previous_d = k, d
    return {"MACD_HIST": histogram, "KDJ_J": j}


def technical_features(bars: list[dict]) -> dict[str, np.ndarray]:
    out = {}
    for name, values in technical_raw(bars).items():
        good = np.isfinite(values)
        x = np.where(good, values, 0.0)
        c = np.concatenate([[0.0], np.cumsum(x)])
        c2 = np.concatenate([[0.0], np.cumsum(x * x)])
        count = np.concatenate([[0], np.cumsum(good.astype(np.int64))])
        idx = np.arange(len(x))
        lo = np.maximum(0, idx - 199)
        span = idx - lo + 1
        mean = (c[idx + 1] - c[lo]) / span
        variance = np.maximum((c2[idx + 1] - c2[lo]) / span - mean * mean, 0.0)
        z = np.clip((x - mean) / np.maximum(np.sqrt(variance), 1e-8), -5.0, 5.0)
        out[name] = np.where(count[idx + 1] - count[lo] == span, z, np.nan)
    return out
