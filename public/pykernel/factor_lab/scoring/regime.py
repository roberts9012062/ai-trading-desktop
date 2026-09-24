"""市场状态分解 —— 冠军因子在趋势上/趋势下/震荡三段的表现

用途：综合分接近的因子可能依赖单一市场状态（只在上行趋势赚钱/只在
趋势里赚钱），regime 分解把测试段按市场状态切开，暴露这类"单腿因子"，
供人工选因子时甄别。纯报告指标，不进适应度。
"""

from __future__ import annotations

from typing import Any

import numpy as np

from ..features import feature_matrix
from ..vm import execute
from .evaluate import _sortino, next_ret, position_from_factor
from .periods import bars_per_year

# 每个状态段至少这么多根 bar 才计算指标（否则该段标 None）
MIN_REGIME_BARS = 30


def regime_masks(close: np.ndarray, window: int = 60) -> dict[str, np.ndarray]:
    """按 60 根滚动收益与波动的关系切三种市场状态（因果，无未来函数）

    趋势上：ret_w > +1.0·σ_w·√w；趋势下：ret_w < -1.0·σ_w·√w；
    其余为震荡。阈值 1σ：纯随机游走 |z|>1 仅约 32% 时间（震荡为主），
    强趋势（每根 Sharpe 0.8 → 60 根 z≈6）稳定判为趋势。
    掩码互斥且覆盖全部 bar（前 window 根为预热期，归入震荡）。
    """
    close = np.asarray(close, dtype=float)
    n = len(close)
    ret1 = np.zeros_like(close)
    ret1[1:] = close[1:] / np.maximum(np.abs(close[:-1]), 1e-9) - 1.0
    up = np.zeros(n, dtype=bool)
    dn = np.zeros(n, dtype=bool)
    if n > window:
        rew = np.zeros(n)
        rew[window:] = close[window:] / np.maximum(np.abs(close[:-window]), 1e-9) - 1.0
        # 滚动波动：ret1 的窗口标准差（向量化：滑动窗平方和）
        c1 = np.concatenate([[0.0], np.cumsum(ret1)])
        c2 = np.concatenate([[0.0], np.cumsum(ret1 ** 2)])
        idx = np.arange(n)
        lo = np.maximum(0, idx - window + 1)
        cnt = idx - lo + 1
        mean = (c1[idx + 1] - c1[lo]) / cnt
        var = np.maximum((c2[idx + 1] - c2[lo]) / cnt - mean ** 2, 0.0)
        sd = np.sqrt(var)
        thresh = 1.0 * sd * np.sqrt(window)
        valid = idx >= window
        up[valid] = rew[valid] > thresh[valid]
        dn[valid] = rew[valid] < -thresh[valid]
    chop = ~(up | dn)
    return {"trend_up": up, "trend_down": dn, "chop": chop}


def regime_decompose(
    tokens: list[int],
    bars: list[dict[str, Any]],
    timeframe: str,
    cost: float,
    prefix_bars: list[dict[str, Any]] | None = None,
) -> dict[str, Any] | None:
    """因子在测试段三种市场状态下的分项指标

    prefix_bars(P1-7):计算特征与因子时拼接的 warmup 前置段(只在
    feature_matrix/execute 中使用,指标仍只算 bars 段)。调用方
    (search._enrich)传入测试段之前的 K 线,消除段首预热区失真。
    返回 {状态: {"sortino", "ann_ret", "bars"}}；因子无效返回 None。
    """
    prefix = list(prefix_bars or [])
    ctx = prefix + list(bars)
    mat = feature_matrix(ctx)
    factor_all = execute(tokens, mat)
    if factor_all is None:
        return None
    factor = factor_all[len(prefix) :]
    close = np.array([float(b.get("close") or 0) for b in bars], dtype=float)
    periods = bars_per_year(bars, timeframe)
    pos = position_from_factor(factor)
    ret = next_ret(close)
    prev = np.roll(pos, 1)
    prev[0] = 0.0
    to = np.abs(pos - prev)
    pnl = pos * ret - to * cost
    masks = regime_masks(close)
    out: dict[str, Any] = {}
    for name, mask in masks.items():
        m = mask.copy()
        m[:1] = False  # 首根无前仓位对应的 pnl
        sel = pnl[m]
        out[name] = {
            "bars": int(m.sum()),
            "sortino": round(float(_sortino(sel, periods)), 3)
            if len(sel) >= MIN_REGIME_BARS
            else None,
            "ann_ret": round(float(sel.mean() * periods), 4)
            if len(sel) >= MIN_REGIME_BARS
            else None,
        }
    return out
