"""算子库 —— 纯 numpy 因果时序算子 + 注册表

注册表条目：(name, fn, arity)。StackVM 据此执行 token 序列。
所有时序算子严格因果（只用当前及历史 bar），无未来函数。

时序算子为向量化实现（cumsum / sliding_window_view），头部不足整窗的
w-1 根按原始定义退化为部分窗口，与旧逐 bar 循环语义等价（1e-12 内）。
"""

from __future__ import annotations

from typing import Any

import numpy as np
from numpy.lib.stride_tricks import sliding_window_view


# ──────────────────────────────────────────────────────────────
# 因果 rolling 辅助（窗口含当前 bar，向前看 w-1 根）
# ──────────────────────────────────────────────────────────────


def ts_mean(x: np.ndarray, w: int) -> np.ndarray:
    """因果滚动均值（头部部分窗口；cumsum 与逐 bar 同算式，逐位等价）"""
    x = np.asarray(x, dtype=float)
    n = len(x)
    if n == 0:
        return np.zeros(0, dtype=float)
    c = np.concatenate([[0.0], np.cumsum(x)])
    idx = np.arange(n)
    lo = np.maximum(0, idx - w + 1)
    return (c[idx + 1] - c[lo]) / (idx - lo + 1)


def ts_std(x: np.ndarray, w: int) -> np.ndarray:
    """因果滚动标准差"""
    x = np.asarray(x, dtype=float)
    m = ts_mean(x, w)
    m2 = ts_mean(x ** 2, w)
    var = np.maximum(m2 - m ** 2, 0.0)
    return np.sqrt(var)


def _rolling_reduce(x: np.ndarray, w: int, reduce_fn, head_fn) -> np.ndarray:
    """滑动窗归约的通用向量化骨架：整窗段用 sliding_window_view，
    头部 w-1 根不足整窗，按部分窗口定义逐根补（数量固定 ≤ w-1，开销可忽略）。
    """
    n = len(x)
    out = np.zeros(n, dtype=float)
    if n == 0:
        return out
    head = min(w - 1, n)
    for i in range(head):
        out[i] = head_fn(x[: i + 1])
    if n >= w:
        sw = sliding_window_view(x, w)
        out[w - 1 :] = reduce_fn(sw)
    return out


def ts_max(x: np.ndarray, w: int) -> np.ndarray:
    x = np.asarray(x, dtype=float)
    return _rolling_reduce(x, w, lambda sw: sw.max(axis=1), lambda h: h.max())


def ts_min(x: np.ndarray, w: int) -> np.ndarray:
    x = np.asarray(x, dtype=float)
    return _rolling_reduce(x, w, lambda sw: sw.min(axis=1), lambda h: h.min())


def ts_rank(x: np.ndarray, w: int) -> np.ndarray:
    """当前值在过去窗口的分位 ∈ (0,1]"""

    def _rank_head(h: np.ndarray) -> float:
        return float((h <= h[-1]).sum()) / len(h)

    def _rank_full(sw: np.ndarray) -> np.ndarray:
        last = sw[:, -1:]
        return (sw <= last).sum(axis=1) / sw.shape[1]

    x = np.asarray(x, dtype=float)
    return _rolling_reduce(x, w, _rank_full, _rank_head)


def ts_zscore(x: np.ndarray, w: int) -> np.ndarray:
    m = ts_mean(x, w)
    s = ts_std(x, w)
    return (x - m) / np.maximum(s, 1e-8)


def delta(x: np.ndarray, n: int) -> np.ndarray:
    """x[i] - x[i-n]，前 n 个为 0"""
    x = np.asarray(x, dtype=float)
    out = np.zeros_like(x)
    if n < len(x):
        out[n:] = x[n:] - x[:-n]
    return out


def ts_corr(x: np.ndarray, y: np.ndarray, w: int) -> np.ndarray:
    """因果滚动相关；窗口不足 2 根或任一侧零方差时为 0"""
    x = np.asarray(x, dtype=float)
    y = np.asarray(y, dtype=float)
    n = len(x)
    out = np.zeros(n, dtype=float)

    def _corr1(a: np.ndarray, b: np.ndarray) -> float:
        if len(a) < 2:
            return 0.0
        am = a - a.mean()
        bm = b - b.mean()
        sa = am.std()
        sb = bm.std()
        if sa < 1e-9 or sb < 1e-9:
            return 0.0
        return float((am * bm).mean() / (sa * sb))

    head = min(w - 1, n)
    for i in range(head):
        out[i] = _corr1(x[: i + 1], y[: i + 1])
    if n >= w:
        swa = sliding_window_view(x, w)
        swb = sliding_window_view(y, w)
        am = swa - swa.mean(axis=1, keepdims=True)
        bm = swb - swb.mean(axis=1, keepdims=True)
        sa = am.std(axis=1)
        sb = bm.std(axis=1)
        cov = (am * bm).mean(axis=1)
        full = np.where(
            (sa < 1e-9) | (sb < 1e-9), 0.0, cov / np.maximum(sa * sb, 1e-300)
        )
        out[w - 1 :] = full
    return out


def _lag(x: np.ndarray, n: int) -> np.ndarray:
    """因果滞后：out[i] = x[i-n]，前 n 根为 0（交叉滞后结构的基础积木）"""
    x = np.asarray(x, dtype=float)
    out = np.zeros_like(x)
    if n < len(x):
        out[n:] = x[:-n]
    return out


def _ema(x: np.ndarray, w: int) -> np.ndarray:
    """因果指数平滑：alpha = 2/(w+1)，y[i]=αx[i]+(1-α)y[i-1]（y[-1]=0）

    用 scipy.signal.lfilter 精确递推（C 速度）；卷积展开式在长序列上
    会因 (1-α)^i 下溢除零，不可用。
    """
    x = np.asarray(x, dtype=float)
    alpha = 2.0 / (w + 1.0)
    try:
        from scipy.signal import lfilter

        return lfilter([alpha], [1.0, -(1.0 - alpha)], x)
    except Exception:
        out = np.zeros_like(x)
        prev = 0.0
        for i, v in enumerate(x):
            prev = alpha * v + (1.0 - alpha) * prev
            out[i] = prev
        return out


def _step(x: Any) -> np.ndarray:
    """阶跃：x>0 → 1，否则 0（条件 gate 的积木，与 MUL 组合成 if 语义）"""
    return (np.asarray(x, dtype=float) > 0.0).astype(float)


def ts_beta(x: np.ndarray, y: np.ndarray, w: int) -> np.ndarray:
    """因果滚动回归 beta：x 对 y（去均值后 cov/var）"""
    x = np.asarray(x, dtype=float)
    y = np.asarray(y, dtype=float)
    n = len(x)
    out = np.zeros(n, dtype=float)
    head = min(w - 1, n)
    for i in range(head):
        a, b = x[: i + 1], y[: i + 1]
        am, bm = a - a.mean(), b - b.mean()
        var = float((bm * bm).mean())
        out[i] = float((am * bm).mean()) / var if var > 1e-12 else 0.0
    if n >= w:
        swa = sliding_window_view(x, w)
        swb = sliding_window_view(y, w)
        am = swa - swa.mean(axis=1, keepdims=True)
        bm = swb - swb.mean(axis=1, keepdims=True)
        var = (bm * bm).mean(axis=1)
        cov = (am * bm).mean(axis=1)
        out[w - 1 :] = np.where(var > 1e-12, cov / np.maximum(var, 1e-300), 0.0)
    return out


def ts_resid(x: np.ndarray, y: np.ndarray, w: int) -> np.ndarray:
    """因果滚动回归残差：(x-MA_x) - beta·(y-MA_y)（去均值价差结构）"""
    x = np.asarray(x, dtype=float)
    y = np.asarray(y, dtype=float)
    beta = ts_beta(x, y, w)
    return (x - ts_mean(x, w)) - beta * (y - ts_mean(y, w))


def _ts_demean(x: np.ndarray, w: int) -> np.ndarray:
    """x - 滚动均值（价格对自身趋势的残差通用式）"""
    return np.asarray(x, dtype=float) - ts_mean(x, w)


# ──────────────────────────────────────────────────────────────
# 一元算子
# ──────────────────────────────────────────────────────────────


def _abs(x: Any) -> np.ndarray:
    return np.abs(np.asarray(x, dtype=float))


def _neg(x: Any) -> np.ndarray:
    return -np.asarray(x, dtype=float)


def _sign(x: Any) -> np.ndarray:
    return np.sign(np.asarray(x, dtype=float))


def _sqrt(x: Any) -> np.ndarray:
    """保留符号的平方根：sign(x)*sqrt(|x|)"""
    x = np.asarray(x, dtype=float)
    return np.sign(x) * np.sqrt(np.abs(x))


def _signed_log(x: Any) -> np.ndarray:
    x = np.asarray(x, dtype=float)
    return np.sign(x) * np.log1p(np.abs(x))


def _sigmoid(x: Any) -> np.ndarray:
    """映射到 (-1,1)：2*sigmoid(x)-1"""
    x = np.clip(np.asarray(x, dtype=float), -30, 30)
    return 2.0 / (1.0 + np.exp(-x)) - 1.0


def _tanh(x: Any) -> np.ndarray:
    return np.tanh(np.clip(np.asarray(x, dtype=float), -30, 30))


# ──────────────────────────────────────────────────────────────
# 二元算子
# ──────────────────────────────────────────────────────────────


def _add(a: Any, b: Any) -> np.ndarray:
    return np.asarray(a, float) + np.asarray(b, float)


def _sub(a: Any, b: Any) -> np.ndarray:
    return np.asarray(a, float) - np.asarray(b, float)


def _mul(a: Any, b: Any) -> np.ndarray:
    return np.asarray(a, float) * np.asarray(b, float)


def _div(a: Any, b: Any) -> np.ndarray:
    return np.asarray(a, float) / np.maximum(np.abs(np.asarray(b, float)), 1e-8) * np.sign(np.asarray(b, float) + 1e-12)


def _min(a: Any, b: Any) -> np.ndarray:
    return np.minimum(np.asarray(a, float), np.asarray(b, float))


def _max(a: Any, b: Any) -> np.ndarray:
    return np.maximum(np.asarray(a, float), np.asarray(b, float))


# ──────────────────────────────────────────────────────────────
# 算子注册表（顺序决定 token id）
# ──────────────────────────────────────────────────────────────

def ts_centered_rank(x: np.ndarray, w: int) -> np.ndarray:
    """Signed midrank with 1e-6 relative/absolute tie tolerance; constants map to zero."""
    def head(h):
        eps = 1e-6 * max(1.0, abs(h[-1]))
        return float(((h < h[-1] - eps).sum() + 0.5 * (np.abs(h - h[-1]) <= eps).sum()) * 2 / len(h) - 1)
    def full(sw):
        last = sw[:, -1:]
        eps = 1e-6 * np.maximum(1.0, np.abs(last))
        return ((sw < last - eps).sum(axis=1) + 0.5 * (np.abs(sw - last) <= eps).sum(axis=1)) * 2 / sw.shape[1] - 1
    return _rolling_reduce(np.asarray(x, dtype=float), w, full, head)


def ts_decay_linear(x: np.ndarray, w: int) -> np.ndarray:
    """Finite causal linear weighting; newest observation has highest weight."""
    def head(h):
        weights = np.arange(1, len(h) + 1, dtype=float)
        return float(h @ weights / weights.sum())
    weights = np.arange(1, w + 1, dtype=float)
    return _rolling_reduce(np.asarray(x, dtype=float), w,
                           lambda sw: (sw @ weights) / weights.sum(), head)


def ts_median(x: np.ndarray, w: int) -> np.ndarray:
    """因果滚动中位数(窗口含当前 bar;robust_zscore 的基座)"""
    x = np.asarray(x, dtype=float)
    return _rolling_reduce(x, w, lambda sw: np.median(sw, axis=1),
                           lambda h: float(np.median(h)))


def ts_mad(x: np.ndarray, w: int) -> np.ndarray:
    """因果滚动 MAD(中位绝对偏差;窗口含当前 bar)"""
    x = np.asarray(x, dtype=float)

    def _mad_full(sw: np.ndarray) -> np.ndarray:
        med = np.median(sw, axis=1, keepdims=True)
        return np.median(np.abs(sw - med), axis=1)

    def _mad_head(h: np.ndarray) -> float:
        med = float(np.median(h))
        return float(np.median(np.abs(h - med)))

    return _rolling_reduce(x, w, _mad_full, _mad_head)


def robust_zscore(x: np.ndarray, w: int, clip: float = 3.0) -> np.ndarray:
    """稳健 zscore:(x − rolling_median) / (1.4826 × MAD),有界截断。

    MAD≈0 且 x≈median → 0;MAD≈0 但 x 偏离 → 按约定饱和到 ±clip,
    不除出无穷(方案 §11.1)。常数输入(整窗相同)输出 0,交上层
    is_constant 过滤。
    """
    x = np.asarray(x, dtype=float)
    med = ts_median(x, w)
    mad = ts_mad(x, w)
    scale = 1.4826 * mad
    with np.errstate(invalid="ignore", divide="ignore"):
        z = np.where(
            scale > 1e-9,
            (x - med) / np.maximum(scale, 1e-9),
            np.where(np.abs(x - med) < 1e-9, 0.0, np.sign(x - med) * clip),
        )
    return np.clip(z, -clip, clip)


def rolling_winsor(x: np.ndarray, w: int, q_lo: float = 0.05, q_hi: float = 0.95) -> np.ndarray:
    """按过去窗口分位数裁剪当前值(方案 §11.1 顺序 1)。

    阈值只用截至 t−1 的观测(当前值不参与自身阈值,避免自截断);
    分位数固定线性插值(numpy 默认)。头部窗口不足 2 个历史值时
    原样返回(不裁剪)。
    """
    x = np.asarray(x, dtype=float)
    n = len(x)
    out = x.copy()
    for i in range(1, n):
        lo = max(0, i - w + 1)
        hist = x[lo:i]  # 不含当前
        if len(hist) < 2:
            continue
        out[i] = float(np.clip(x[i], np.quantile(hist, q_lo), np.quantile(hist, q_hi)))
    return out


OPS_CONFIG: list[tuple[str, Any, int]] = [
    # 二元
    ("ADD", _add, 2),
    ("SUB", _sub, 2),
    ("MUL", _mul, 2),
    ("DIV", _div, 2),
    ("MIN", _min, 2),
    ("MAX", _max, 2),
    # 一元
    ("ABS", _abs, 1),
    ("NEG", _neg, 1),
    ("SIGN", _sign, 1),
    ("SQRT", _sqrt, 1),
    ("SIGNED_LOG", _signed_log, 1),
    ("SIGMOID", _sigmoid, 1),
    ("TANH", _tanh, 1),
    # 时序（一元，多窗口）
    ("TS_MA_5", lambda a: ts_mean(a, 5), 1),
    ("TS_MA_10", lambda a: ts_mean(a, 10), 1),
    ("TS_MA_20", lambda a: ts_mean(a, 20), 1),
    ("TS_STD_10", lambda a: ts_std(a, 10), 1),
    ("TS_STD_20", lambda a: ts_std(a, 20), 1),
    ("TS_MAX_10", lambda a: ts_max(a, 10), 1),
    ("TS_MAX_20", lambda a: ts_max(a, 20), 1),
    ("TS_MIN_10", lambda a: ts_min(a, 10), 1),
    ("TS_RANK_10", lambda a: ts_rank(a, 10), 1),
    ("TS_RANK_20", lambda a: ts_rank(a, 20), 1),
    ("TS_ZSCORE_20", lambda a: ts_zscore(a, 20), 1),
    ("DELTA_1", lambda a: delta(a, 1), 1),
    ("DELTA_5", lambda a: delta(a, 5), 1),
    ("TS_ATR_NORM", lambda a: _signed_log(np.maximum(np.abs(a), 1e-9)), 1),
    # ── 扩容批次1（append-only，算子 id 从 29 起追加；顺序冻结不可重排）──
    ("LAG_1", lambda a: _lag(a, 1), 1),
    ("LAG_5", lambda a: _lag(a, 5), 1),
    ("CORR_20", lambda a, b: ts_corr(a, b, 20), 2),
    ("TS_MA_60", lambda a: ts_mean(a, 60), 1),
    ("TS_STD_60", lambda a: ts_std(a, 60), 1),
    ("TS_ZSCORE_60", lambda a: ts_zscore(a, 60), 1),
    ("TS_RANK_60", lambda a: ts_rank(a, 60), 1),
    # ── 扩容批次2（id 34 起追加；回归/条件/平滑类）──
    ("TS_DEMEAN_20", lambda a: _ts_demean(a, 20), 1),
    ("BETA_20", lambda a, b: ts_beta(a, b, 20), 2),
    ("RESID_20", lambda a, b: ts_resid(a, b, 20), 2),
    ("STEP", _step, 1),
    ("EMA_5", lambda a: _ema(a, 5), 1),
    ("EMA_20", lambda a: _ema(a, 20), 1),
    ("TS_CRANK_20", lambda a: ts_centered_rank(a, 20), 1),
    ("TS_CRANK_60", lambda a: ts_centered_rank(a, 60), 1),
    ("DECAY_LINEAR_10", lambda a: ts_decay_linear(a, 10), 1),
    ("DECAY_LINEAR_20", lambda a: ts_decay_linear(a, 20), 1),
    # ── 扩容批次3(id 44 起,append-only;crypto_local_v2 稳健变换)──
    # robust_zscore:滚动中位数/MAD 稳健标准化,有界截断(方案 §11.1)
    ("ROBUST_ZSCORE_20", lambda a: robust_zscore(a, 20), 1),
    # rolling_winsor:按过去窗口分位数裁剪,阈值截至 t−1(方案 §11.1)
    ("WINSOR_20", lambda a: rolling_winsor(a, 20), 1),
]

OPS_NAMES: tuple[str, ...] = tuple(name for name, _, _ in OPS_CONFIG)
OP_INDEX: dict[str, int] = {name: i for i, name in enumerate(OPS_NAMES)}


def op_arity(op_name: str) -> int:
    """取算子元数"""
    for name, _, arity in OPS_CONFIG:
        if name == op_name:
            return arity
    return 0
