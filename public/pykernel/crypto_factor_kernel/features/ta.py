"""技术分析原语 —— MACD / ADX / Donchian / 区间波动率 / 量价流动 性特征内核

扩容批次4（2026-09，A 级：纯 OHLCV 可算，不依赖新数据源）。
所有函数严格因果（只用当前及历史 bar），向量化 numpy，窗口头部
按部分窗口退化（与 ops.py 的滚动算子口径一致）。

为什么做成特征而不是算子组合：特征矩阵进 VM 前已经过因果 zscore，
在归一化值上做算术拼不出原始价量语义（如 std/ma、EMA 差），
凡需要原始 OHLCV 算术的量必须以独立特征形式提供。
"""

from __future__ import annotations

import numpy as np

from ..ops import ts_max, ts_mean, ts_min, ts_std


def macd(close: np.ndarray, fast: int = 12, slow: int = 26) -> np.ndarray:
    """MACD 主线 (EMA12 - EMA26) / close —— 价格归一后交给统一 zscore"""
    return (_ema(close, fast) - _ema(close, slow)) / np.maximum(close, 1e-9)


def _ema(x: np.ndarray, w: int) -> np.ndarray:
    """因果指数平滑（与 ops._ema 同式：alpha=2/(w+1)，y[-1]=0）

    这里复制一份而非 import：ops._ema 是私有函数，特征层引用私有名
    会在算子层重构时静默断掉；两处口径由测试 test_macd_semantics 钉住。
    """
    alpha = 2.0 / (w + 1.0)
    try:
        from scipy.signal import lfilter

        return lfilter([alpha], [1.0, -(1.0 - alpha)], np.asarray(x, dtype=float))
    except Exception:
        out = np.zeros_like(x)
        prev = 0.0
        for i, v in enumerate(np.asarray(x, dtype=float)):
            prev = alpha * v + (1.0 - alpha) * prev
            out[i] = prev
        return out


def adx(high: np.ndarray, low: np.ndarray, close: np.ndarray, n: int = 14) -> np.ndarray:
    """ADX 趋势强度（0~100 / 100 → [0,1]）

    经典 DMI：+DM/-DM 与 TR 做 n 周期平滑（此处用滚动均值近似
    Wilder 平滑，特征语义等价），DX = |+DI − −DI| / (+DI + −DI)，
    ADX = DX 的 n 周期均值。趋势越强值越大，无量纲。
    """
    prev_high = np.concatenate([[high[0]], high[:-1]])
    prev_low = np.concatenate([[low[0]], low[:-1]])
    prev_close = np.concatenate([[close[0]], close[:-1]])
    up = high - prev_high
    dn = prev_low - low
    plus_dm = np.where((up > dn) & (up > 0), up, 0.0)
    minus_dm = np.where((dn > up) & (dn > 0), dn, 0.0)
    tr = np.maximum(
        high - low,
        np.maximum(np.abs(high - prev_close), np.abs(low - prev_close)),
    )
    atr = ts_mean(tr, n)
    plus_di = ts_mean(plus_dm, n) / np.maximum(atr, 1e-12)
    minus_di = ts_mean(minus_dm, n) / np.maximum(atr, 1e-12)
    dx = np.abs(plus_di - minus_di) / np.maximum(plus_di + minus_di, 1e-12)
    return ts_mean(dx, n)


def donchian_pos(high: np.ndarray, low: np.ndarray, close: np.ndarray, n: int = 20) -> np.ndarray:
    """Donchian 通道位置 [-1, +1]：通道下沿 -1 / 上沿 +1

    close 相对过去 n 根高低点区间的位置（突破上沿会 >1、跌破下沿 <-1，
    保留溢出——突破强度本身是信息，由统一 zscore 收敛量纲）。
    """
    hi = ts_max(high, n)
    lo = ts_min(low, n)
    rng = np.maximum(hi - lo, 1e-12)
    return (close - lo) / rng * 2.0 - 1.0


def parkinson(high: np.ndarray, low: np.ndarray, n: int = 20) -> np.ndarray:
    """Parkinson 区间波动率：sqrt(mean(ln(h/l)^2))

    只用高低价，比收盘价波动率高效约 5 倍；对数口径天然无量纲。
    """
    lr = np.log(np.maximum(high, 1e-12) / np.maximum(low, 1e-12))
    return np.sqrt(ts_mean(lr ** 2, n))


def garman_klass(
    high: np.ndarray, low: np.ndarray, open_: np.ndarray, close: np.ndarray, n: int = 20
) -> np.ndarray:
    """Garman-Klass 区间波动率（O/H/L/C 四价估计量）

    sqrt(mean(0.5·ln(h/l)² − (2ln2−1)·ln(c/o)²))；单根项可为负，
    窗口均值在退化 bar 上可能微负，开方前钳 0。
    不用 Yang-Zhang：其增量主要处理隔夜跳空，7×24 无隔夜概念。
    """
    hl = np.log(np.maximum(high, 1e-12) / np.maximum(low, 1e-12))
    co = np.log(np.maximum(close, 1e-12) / np.maximum(open_, 1e-12))
    var = ts_mean(0.5 * hl ** 2 - (2.0 * np.log(2.0) - 1.0) * co ** 2, n)
    return np.sqrt(np.maximum(var, 0.0))


def semivol_ratio(close: np.ndarray, n: int = 20) -> np.ndarray:
    """下行/上行半波动比（>1 = 下行波动占优，恐惧信号）

    ret<0 与 ret>0 分开求 RMS，比值做符号对数压缩稳定量纲；
    任一侧无样本（窗口全涨/全跌）时为 0（中性）。
    """
    ret = _ret_np(close, 1)
    dn = np.where(ret < 0, ret, 0.0)
    up = np.where(ret > 0, ret, 0.0)
    d_rms = np.sqrt(ts_mean(dn ** 2, n))
    u_rms = np.sqrt(ts_mean(up ** 2, n))
    ratio = np.maximum(d_rms / np.maximum(u_rms, 1e-12), 1e-6)
    both = (ts_mean((ret < 0).astype(float), n) > 0) & (
        ts_mean((ret > 0).astype(float), n) > 0
    )
    return np.where(both, np.log(ratio), 0.0)


def vol_of_vol(close: np.ndarray, n: int = 20) -> np.ndarray:
    """波动率的波动（vol-of-vol）：std(滚动std) / std

    高 vol-of-vol = 波动聚集切换频繁（regime 不稳定），O(1) 量纲。
    """
    ret = _ret_np(close, 1)
    base = ts_std(ret, n)
    outer = ts_std(base, n)
    return outer / np.maximum(base, 1e-12)


def jump_freq(close: np.ndarray, n: int = 20, k: float = 3.0) -> np.ndarray:
    """跳变频率：过去 n 根中 |ret| > k·σ(20) 的占比 [0,1]

    跳变（信息事件驱动的大幅瞬时移动）占比高 = 价格过程偏离
    连续扩散、均值回归与动量结构都更脆弱。
    """
    ret = _ret_np(close, 1)
    sigma = ts_std(ret, n)
    flag = (np.abs(ret) > k * sigma).astype(float)
    return ts_mean(flag, n)


def vwap_dev(high: np.ndarray, low: np.ndarray, close: np.ndarray, volume: np.ndarray, n: int = 20) -> np.ndarray:
    """VWAP 偏离率：(close − n 周期成交量加权均价) / VWAP

    典型价 = (h+l+c)/3；滚动和用均值比等价替换（分子分母同窗）。
    """
    tp = (high + low + close) / 3.0
    vwap = ts_mean(tp * volume, n) / np.maximum(ts_mean(volume, n), 1e-12)
    return (close - vwap) / np.maximum(np.abs(vwap), 1e-9)


def amihud(close: np.ndarray, volume: np.ndarray, n: int = 20) -> np.ndarray:
    """Amihud 非流动性：mean(|ret| / volume) 的符号对数压缩

    单位量纲冲击成本代理——同样 1% 波动所需成交量越小、流动性越差。
    对数压缩把跨 6 个数量级的原始值压进线性区间再交 zscore。
    """
    ret = _ret_np(close, 1)
    illiq = ts_mean(np.abs(ret) / np.maximum(volume, 1e-9), n)
    return np.sign(illiq) * np.log1p(np.abs(illiq) * 1e6)  # ×1e6 对齐常见量级


def mfi(high: np.ndarray, low: np.ndarray, close: np.ndarray, volume: np.ndarray, n: int = 14) -> np.ndarray:
    """MFI 资金流量指标（0~100 → [-1,1]，与 RSI14 同映射）

    典型价涨 = 正资金流、跌 = 负资金流，n 周期正负流之比。
    """
    tp = (high + low + close) / 3.0
    prev_tp = np.concatenate([[tp[0]], tp[:-1]])
    flow = tp * volume
    pos = np.where(tp > prev_tp, flow, 0.0)
    neg = np.where(tp < prev_tp, flow, 0.0)
    ratio = ts_mean(pos, n) / np.maximum(ts_mean(neg, n), 1e-12)
    m = 1.0 - 1.0 / (1.0 + ratio)
    return m * 2.0 - 1.0


def cmf(high: np.ndarray, low: np.ndarray, close: np.ndarray, volume: np.ndarray, n: int = 20) -> np.ndarray:
    """Chaikin 资金流 CMF [-1,1]：收盘位置加权的净流入占比

    CLV = ((c−l)−(h−c))/(h−l)，CMF = Σ(CLV·vol) / Σvol（均值比等价）。
    """
    rng = np.maximum(high - low, 1e-12)
    clv = ((close - low) - (high - close)) / rng
    return ts_mean(clv * volume, n) / np.maximum(ts_mean(volume, n), 1e-12)


def _ret_np(close: np.ndarray, n: int) -> np.ndarray:
    out = np.zeros_like(close)
    if n < len(close):
        prev = close[:-n]
        out[n:] = (close[n:] - prev) / np.maximum(np.abs(prev), 1e-9)
    return out
