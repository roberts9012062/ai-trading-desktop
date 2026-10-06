"""数值原语 —— 收益 / ATR / RSI / 自相关 / 因果 zscore / 滚动矩 / 持仓量提取

自单文件 features.py 拆出（2026-08-31，行为零变化）；特征组合与矩阵缓存
见 compute.py / matrix.py。所有函数严格因果（只用当前及历史 bar）。
"""

from __future__ import annotations

import math
from typing import Any

import numpy as np

from ..ops import ts_mean, ts_std
from ..scoring.periods import distinct_trading_days

# 因果归一化的基础窗口（日线语义：约一年）
_BASE_ZSCORE_WINDOW = 200


def _to_arr(bars: list[dict[str, Any]], key: str) -> np.ndarray:
    return np.array([float(b.get(key) or 0) for b in bars], dtype=float)


def _ret(close: np.ndarray, n: int) -> np.ndarray:
    out = np.zeros_like(close)
    if n < len(close):
        prev = close[:-n]
        out[n:] = (close[n:] - prev) / np.maximum(np.abs(prev), 1e-9)
    return out


def _atr(high: np.ndarray, low: np.ndarray, close: np.ndarray, n: int) -> np.ndarray:
    prev_close = np.concatenate([[close[0]], close[:-1]])
    tr = np.maximum(
        high - low,
        np.maximum(np.abs(high - prev_close), np.abs(low - prev_close)),
    )
    return ts_mean(tr, n)


def _rsi(close: np.ndarray, n: int) -> np.ndarray:
    d = np.diff(close, prepend=close[0])
    up = np.where(d > 0, d, 0.0)
    dn = np.where(d < 0, -d, 0.0)
    au = ts_mean(up, n)
    ad = ts_mean(dn, n)
    rs = au / np.maximum(ad, 1e-9)
    rsi = 100.0 - 100.0 / (1.0 + rs)
    return (rsi - 50.0) / 50.0  # 归一化到 [-1, 1]


def _ac1(close: np.ndarray, w: int) -> np.ndarray:
    x = _ret(close, 1)
    out = np.zeros_like(x)
    for i in range(1, len(x)):
        lo = max(0, i - w)
        a = x[lo : i + 1]
        if len(a) < 2:
            continue
        am = a[:-1] - a[:-1].mean()
        bm = a[1:] - a[1:].mean()
        sa = am.std()
        sb = bm.std()
        if sa < 1e-9 or sb < 1e-9:
            continue
        out[i] = float((am * bm).mean() / (sa * sb))
    return out


def _zscore_causal(x: np.ndarray, w: int) -> np.ndarray:
    m = ts_mean(x, w)
    s = ts_std(x, w)
    z = (x - m) / np.maximum(s, 1e-8)
    return np.clip(z, -5.0, 5.0)


def zscore_window(bars: list[dict[str, Any]]) -> int:
    """因果归一化窗口 —— 至少覆盖一个完整交易日

    固定 200 根在日线上约合一年，语义合理；但在 1m 上只有 200 分钟，
    短于一个交易日（约 345 分钟），归一化基线跨不过完整交易时段，
    无法消化日内季节性。这里按实测日均 bar 数抬高下限。

    日均 bar 数直接由 bars 的交易日跨度推出，不需要外部传周期；
    1d（日均 1 根）与 5m 及以上周期结果仍是 200，只有 1m 会被抬高。
    """
    days = distinct_trading_days(bars)
    if days <= 0 or not bars:
        return _BASE_ZSCORE_WINDOW
    per_day = len(bars) / days
    return max(_BASE_ZSCORE_WINDOW, int(math.ceil(per_day)))


def _open_interest(bars: list[dict[str, Any]]) -> tuple[np.ndarray, bool]:
    """持仓量序列与可用性

    缺失值用前一根的值前向填充（因果）；整段都没有持仓量时返回
    (全零, False)，由调用方把仓量类特征置零，避免造出假信号。
    """
    raw = [bar.get("open_interest") for bar in bars]
    if not any(v is not None for v in raw):
        return np.zeros(len(bars), dtype=float), False
    out = np.zeros(len(bars), dtype=float)
    last = 0.0
    for i, value in enumerate(raw):
        if value is not None:
            last = float(value)
        out[i] = last
    return out, True


def _funding(bars: list[dict[str, Any]]) -> tuple[np.ndarray, bool]:
    """资金费率序列与可用性（8h 结算点已由富化层前向填充到 bar）

    与 _open_interest 同语义：整段无数据 → (全零, False) 置零防假信号。
    """
    return _ffill_field(bars, "funding_rate")


def _ffill_field(
    bars: list[dict[str, Any]], field: str
) -> tuple[np.ndarray, bool]:
    """富化注入字段的通用提取：缺失前向填充，整段缺 → (全零, False)

    供 funding/lsr/taker/xspread 等由 deriv_history 富化的字段复用；
    全零段返回 False 让特征层置零（与 OI 的 fail-safe 同语义）。
    """
    raw = [bar.get(field) for bar in bars]
    if not any(v is not None for v in raw):
        return np.zeros(len(bars), dtype=float), False
    out = np.zeros(len(bars), dtype=float)
    last = 0.0
    for i, value in enumerate(raw):
        if value is not None:
            last = float(value)
        out[i] = last
    return out, True


def _btc_ret(bars: list[dict[str, Any]]) -> tuple[np.ndarray, bool]:
    """BTC 同周期收益序列与可用性（跨资产上下文，由富化层按 bar 时间对齐注入）

    整段无数据 → (全零, False)；BTC 自身也返回 False（btc_ret≈自身收益，
    EXCESS_RET 退化为常数，置零跳过）。
    """
    raw = [bar.get("btc_ret") for bar in bars]
    if not any(v is not None for v in raw):
        return np.zeros(len(bars), dtype=float), False
    out = np.zeros(len(bars), dtype=float)
    for i, value in enumerate(raw):
        if value is not None:
            out[i] = float(value)
    if float(np.abs(out).sum()) < 1e-12:
        return out, False
    return out, True


def _rolling_moment(x: np.ndarray, w: int, order: int) -> np.ndarray:
    """滚动中心矩（3=偏度、4=峰度），向量化 + 头部部分窗口"""
    from numpy.lib.stride_tricks import sliding_window_view

    n = len(x)
    out = np.zeros(n, dtype=float)

    def _m(h: np.ndarray) -> float:
        d = h - h.mean()
        s = d.std()
        if s < 1e-12:
            return 0.0
        return float((d ** order).mean()) / s ** order

    head = min(w - 1, n)
    for i in range(head):
        out[i] = _m(x[: i + 1])
    if n >= w:
        sw = sliding_window_view(x, w)
        d = sw - sw.mean(axis=1, keepdims=True)
        s = d.std(axis=1)
        with np.errstate(divide="ignore", invalid="ignore"):
            mom = (d ** order).mean(axis=1) / np.where(s > 1e-12, s ** order, 1.0)
        out[w - 1 :] = np.where(s > 1e-12, mom, 0.0)
    return out
