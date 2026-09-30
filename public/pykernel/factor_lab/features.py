"""因子特征工程 —— 期货 OHLCV + 持仓量 + 日内时间 因果特征

所有特征严格因果（只用当前及历史 bar），无未来函数。
价量类特征经因果 zscore 归一化并 clip[-5,5]；
时间类特征本身已在 [-1,1] 且带日内周期语义，不做 zscore
（200 根窗口在 1m 上不足一个交易日，zscore 会把日内周期抹平）。

特征顺序由 FEATURE_NAMES 固定，VM 据此索引。新增特征只能追加在末尾，
且不会影响算子 token（特征 id 空间已冻结，见 token_encoding.py）。
"""

from __future__ import annotations

import math
from collections import OrderedDict
from typing import Any

import numpy as np

from signal_strength import DEFAULT_STRENGTH_PARAMS, calc_strength
from .ops import delta, ts_corr, ts_max, ts_mean, ts_min, ts_std
from .scoring.periods import distinct_trading_days

# 交易日从 21:00（夜盘开盘）起算，跨到次日 15:00 收盘，共 18 小时
_DAY_START_MIN = 21 * 60
_DAY_SPAN_MIN = 18 * 60
# 夜盘时段：21:00 之后，或次日 03:00 之前（贵金属等跨夜品种）
_NIGHT_END_MIN = 3 * 60
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
    """因果归一化窗口(旧口径) —— 至少覆盖一个完整交易日

    固定 200 根在日线上约合一年，语义合理；但在 1m 上只有 200 分钟，
    短于一个交易日（约 345 分钟），归一化基线跨不过完整交易时段，
    无法消化日内季节性。这里按实测日均 bar 数抬高下限。

    日均 bar 数直接由 bars 的交易日跨度推出，不需要外部传周期；
    1d（日均 1 根）与 5m 及以上周期结果仍是 200，只有 1m 会被抬高。

    已知局限(方案 2.1-C):分子 len(bars) 含全段,追加未来数据会改变
    过去的归一化基线 —— 旧 profile 保持该口径逐位不变;crypto_local_v2
    走 research_context.norm_window_for_bars(头部 bar 间距推导,前缀不变)。
    """
    from .market import is_v2

    if is_v2(bars):
        from .research_context import norm_window_for_bars

        return norm_window_for_bars(bars)
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


def _clock_minutes(bar_time: str) -> int | None:
    """从 bar 时间串取当日时钟分钟数；日线（无时刻部分）返回 None"""
    text = bar_time.strip()
    if len(text) < 16:
        return None
    try:
        return int(text[11:13]) * 60 + int(text[14:16])
    except ValueError:
        return None


def _time_of_day(bars: list[dict[str, Any]]) -> np.ndarray:
    """交易日内时钟进度，映射到 [-1, 1]

    21:00 夜盘开盘为 -1，次日 15:00 收盘为 +1。只用 bar 自身的时钟，
    不依赖「当日共几根」，因此没有未来信息。日线恒为 0。
    """
    out = np.zeros(len(bars), dtype=float)
    for i, bar in enumerate(bars):
        minutes = _clock_minutes(str(bar.get("time") or ""))
        if minutes is None:
            continue
        elapsed = (minutes - _DAY_START_MIN) % (24 * 60)
        out[i] = min(elapsed / _DAY_SPAN_MIN, 1.0) * 2.0 - 1.0
    return out


def _is_night(bars: list[dict[str, Any]]) -> np.ndarray:
    """夜盘标记：21:00 之后或次日 03:00 之前为 1，日线恒 0"""
    out = np.zeros(len(bars), dtype=float)
    for i, bar in enumerate(bars):
        minutes = _clock_minutes(str(bar.get("time") or ""))
        if minutes is None:
            continue
        if minutes >= _DAY_START_MIN or minutes < _NIGHT_END_MIN:
            out[i] = 1.0
    return out


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


def _dow_dom(bars: list[dict[str, Any]]) -> tuple[np.ndarray, np.ndarray]:
    """周内日（周一=-1..周五=+1）与月内位置（[−1,1]），日线/分钟通用

    从 bar 日期取 weekday——注意期货交易日（夜盘归属次日）与自然日不同，
    此处用自然日 weekday（简单且因果）；无日期返回 0。
    """
    from datetime import date

    n = len(bars)
    dow = np.zeros(n, dtype=float)
    dom = np.zeros(n, dtype=float)
    for i, bar in enumerate(bars):
        t = str(bar.get("time") or "")[:10]
        if len(t) < 10:
            continue
        try:
            d = date.fromisoformat(t)
        except ValueError:
            continue
        dow[i] = (d.weekday() - 2) / 2.0  # Mon=-1 .. Fri=+1
        dom[i] = (d.day - 15.5) / 15.5
    return dow, dom


# 因子语境用默认参数(14/3/1/10):与图表默认副图一致,保证特征语义
# 与用户所见曲线同源;挖掘侧如需自定义窗口应另立特征名(append-only)
_STRENGTH_PARAMS = DEFAULT_STRENGTH_PARAMS


def strength_series(bars: list[dict[str, Any]]) -> np.ndarray:
    """强弱主值序列映射到 [-1, 1]:0 → -1,100 → +1

    窗口不满(bars 少于 period 根)时无输出,头部补 0(与其它特征
    的头部置零惯例一致,zscore 后不产生假信号)。
    """
    res = calc_strength(bars, _STRENGTH_PARAMS)
    out = np.zeros(len(bars), dtype=float)
    first = int(_STRENGTH_PARAMS["period"]) - 1
    points = res["points"]
    for k, point in enumerate(points):
        # 输出点取二次平滑序列;smooth2=1(默认)时与主序列位级相同
        out[first + k] = float(point["close"]) / 50.0 - 1.0
    return out


# ── 桌面端本地专属批次(id 36-39,append-only)─────────────────────
# 服务端 FEAT_COUNT=36 不含以下特征(本批次为桌面端有意的本地分叉,
# 与服务端合并时按此注释识别):含这些 token 的公式服务端无法执行,
# 由 factor_local 打 local_only 标、前端拦截收藏/服务端任务挂载;
# 本地引擎 AI 任务信号在客户端计算(factor_np.py),可正常使用。
# 选型原则:全部为现有 36 特征 + 40 算子无法(或极难)组合表达的
# 路径依赖/条件统计量,提供真实的增量信息而非便利冗余。


def _streak(close: np.ndarray, cap: int = 12) -> np.ndarray:
    """连续同向收盘计数(路径依赖):方向 × min(连涨/连跌根数, cap) / cap

    需要跨根状态累积,无法由现有算子组合表达;逐根单遍 O(n),
    与 _ac1/_open_interest 同属特征层的逐 bar 循环(仅计算一次并缓存)。
    """
    n = len(close)
    out = np.zeros(n, dtype=float)
    run_sign = 0.0
    run_len = 0
    for i in range(1, n):
        if close[i] > close[i - 1]:
            s = 1.0
        elif close[i] < close[i - 1]:
            s = -1.0
        else:
            s = 0.0
        if s == 0.0:
            run_len = 0
        elif s == run_sign:
            run_len += 1
        else:
            run_sign = s
            run_len = 1
        out[i] = run_sign * min(run_len, cap)
    return out / cap


def _vwap_dev(
    high: np.ndarray, low: np.ndarray, close: np.ndarray, volume: np.ndarray, w: int = 20
) -> np.ndarray:
    """收盘对量加权典型价均线的偏离(算子库无加权均价,无法组合表达)"""
    tp = (high + low + close) / 3.0
    vwap = ts_mean(tp * volume, w) / np.maximum(ts_mean(volume, w), 1e-9)
    return (close - vwap) / np.maximum(np.abs(vwap), 1e-9)


def _updown_vol_ratio(close: np.ndarray, w: int = 20) -> np.ndarray:
    """上行/下行收益波动占比:(E[up²]−E[dn²])/(E[up²]+E[dn²]) ∈ [−1,1]

    条件统计——把波动按涨跌方向分桶,现有算子无条件分流能力;
    正值 = 涨时波动占优,负值 = 跌时波动占优(波动不对称性)。
    """
    r = _ret(close, 1)
    up = np.where(r > 0, r, 0.0)
    dn = np.where(r < 0, -r, 0.0)
    su = ts_mean(up * up, w)
    sd = ts_mean(dn * dn, w)
    return (su - sd) / np.maximum(su + sd, 1e-12)


def _chan_pos(
    high: np.ndarray, low: np.ndarray, close: np.ndarray, w: int = 20
) -> np.ndarray:
    """收盘在 w 根高低通道内的位置,映射 [−1,1](下轨 −1 / 上轨 +1)

    MIN/MAX+DIV 组合在语法上可达但需 7+ token 且深度易超限,
    作为特征直接提供高频组合的高性价比入口。
    """
    hh = ts_max(high, w)
    ll = ts_min(low, w)
    return (close - ll) / np.maximum(hh - ll, 1e-9) * 2.0 - 1.0


def compute_features(bars: list[dict[str, Any]]) -> dict[str, np.ndarray]:
    """计算全部特征，返回 name -> [T] 因果归一化数组"""
    close = _to_arr(bars, "close")
    high = _to_arr(bars, "high")
    low = _to_arr(bars, "low")
    open_ = _to_arr(bars, "open")
    volume = _to_arr(bars, "volume").astype(float)
    open_interest, has_oi = _open_interest(bars)

    ma20 = ts_mean(close, 20)
    std20 = ts_std(close, 20)
    ma60 = ts_mean(close, 60)
    std60 = ts_std(close, 60)
    vol_ma = ts_mean(volume, 20)
    vol_std = ts_std(volume, 20)
    zeros = np.zeros_like(close)
    oi_delta = delta(open_interest, 1)
    rng = np.maximum(high - low, 1e-9)

    gap = np.zeros_like(close)
    gap[1:] = (open_[1:] - close[:-1]) / np.maximum(np.abs(close[:-1]), 1e-9)

    raw: dict[str, np.ndarray] = {
        # 趋势
        "RET": _ret(close, 1),
        "RET5": _ret(close, 5),
        "RET20": _ret(close, 20),
        "MA_DIFF": (close - ma20) / np.maximum(np.abs(ma20), 1e-9),
        "SLOPE20": delta(ma20, 5) / np.maximum(np.abs(ma20), 1e-9),
        # 波动
        "ATR14": _atr(high, low, close, 14) / np.maximum(close, 1e-9),
        "RVOL": vol_std / np.maximum(vol_ma, 1e-9),
        "HL_RANGE": (high - low) / np.maximum(close, 1e-9),
        # 反转
        "DEV": (close - ma20) / np.maximum(std20, 1e-9),
        "RSI14": _rsi(close, 14),
        "AC1": _ac1(close, 20),
        # 量能
        "VOL_RATIO": volume / np.maximum(vol_ma, 1e-9),
        "VOL_Z": (volume - vol_ma) / np.maximum(vol_std, 1e-9),
        "PV_CORR": ts_corr(_ret(close, 1), volume, 20),
        # 持仓量（期货独有）—— 缺持仓量数据时整体置零，不造假信号
        "OI_CHG": (
            oi_delta / np.maximum(np.abs(open_interest), 1.0) if has_oi else zeros
        ),
        "OI_PV": (
            np.sign(_ret(close, 1)) * np.sign(oi_delta) if has_oi else zeros
        ),
        "VOL_OI": (
            volume / np.maximum(open_interest, 1.0) if has_oi else zeros
        ),
        # ── 扩容批次1（append-only，id 从 19 起；旧 token 语义不可变）──
        # K 线微观结构（首次使用 open 字段：跳空/影线/实体/收盘位置）
        "GAP": gap,
        "CLOSE_POS": (close - low) / rng,
        "UPPER_SHADOW": (high - np.maximum(open_, close)) / np.maximum(close, 1e-9),
        "LOWER_SHADOW": (np.minimum(open_, close) - low) / np.maximum(close, 1e-9),
        "BODY": (close - open_) / np.maximum(close, 1e-9),
        # 长窗口结构（算子窗口上限 20，多周期只能由特征层提供）
        "RET60": _ret(close, 60),
        "MA_DIFF60": (close - ma60) / np.maximum(np.abs(ma60), 1e-9),
        "VOLAT_RATIO": std20 / np.maximum(std60, 1e-9),
        # ── 扩容批次2（id 27 起）：量仓相关 / 高阶矩 / 日历 ──
        "OI_PC": (
            ts_corr(_ret(close, 1), oi_delta, 20) if has_oi else zeros
        ),
        "OI_CHG5": (
            delta(open_interest, 5) / np.maximum(np.abs(open_interest), 1.0)
            if has_oi
            else zeros
        ),
        "OI_CHG20": (
            delta(open_interest, 20) / np.maximum(np.abs(open_interest), 1.0)
            if has_oi
            else zeros
        ),
        "VOL_OI_MA": (
            ts_mean(volume / np.maximum(open_interest, 1.0), 20)
            if has_oi
            else zeros
        ),
        "SKEW20": _rolling_moment(_ret(close, 1), 20, 3),
        "KURT20": _rolling_moment(_ret(close, 1), 20, 4),
        # ── 扩容批次3(id 35):强弱值(图表强弱指标同口径,默认参数)──
        "STRENGTH": strength_series(bars),
        # ── 桌面端本地专属(id 36-39):仅本地可执行,token 不与服务端互认 ──
        "STREAK": _streak(close),
        "VWAP_DEV": _vwap_dev(high, low, close, volume),
        "UPDOWN_VOL_RATIO": _updown_vol_ratio(close),
        "CHAN_POS": _chan_pos(high, low, close),
    }
    # 价量类做因果归一化（窗口至少覆盖一个完整交易日）
    window = zscore_window(bars)
    out = {name: _zscore_causal(arr, window) for name, arr in raw.items()}
    # 时间类已在 [-1,1] 且带日内周期语义，zscore 会把周期抹平，故不归一化
    out["TOD"] = _time_of_day(bars)
    out["NIGHT"] = _is_night(bars)
    # 日历类同理：周期语义值，zscore 会抹平周内效应
    dow, dom = _dow_dom(bars)
    out["DOW"] = dow
    out["DOM"] = dom
    # New IDs have fixed causal windows; legacy rows retain their semantics.
    out.update(_crypto_features(bars, close, high, low, volume))
    return out


def _crypto_features(bars, close, high, low, volume):
    from .market import utc_time
    n = len(bars)
    clock = {k: np.zeros(n) for k in ("UTC_HOUR_SIN", "UTC_HOUR_COS", "UTC_WEEK_SIN", "UTC_WEEK_COS", "UTC_WEEKEND")}
    for i, bar in enumerate(bars):
        dt = utc_time(bar.get("time", ""))
        if dt is None:
            continue
        if len(str(bar.get("time", ""))) > 10:
            phase = 2 * np.pi * (dt.hour * 60 + dt.minute) / 1440
            clock["UTC_HOUR_SIN"][i] = np.sin(phase)
            clock["UTC_HOUR_COS"][i] = np.cos(phase)
        phase = 2 * np.pi * dt.weekday() / 7
        clock["UTC_WEEK_SIN"][i] = np.sin(phase)
        clock["UTC_WEEK_COS"][i] = np.cos(phase)
        clock["UTC_WEEKEND"][i] = float(dt.weekday() >= 5)
    clock = {name: np.round(values, 7) for name, values in clock.items()}
    r = _ret(close, 1)
    vol = ts_std(r, 20)
    amount = np.maximum(close * volume, 1e-9)  # OHLCV turnover proxy
    raw = {
        "CRYPTO_MOM6": _ret(close, 6) / np.maximum(vol * np.sqrt(6), 1e-8),
        "CRYPTO_MOM24": _ret(close, 24) / np.maximum(vol * np.sqrt(24), 1e-8),
        "CRYPTO_VOL20": vol,
        "CRYPTO_ILLIQ20": np.log(np.maximum(ts_mean(np.abs(r) / amount, 20), 1e-30)),
        "CRYPTO_FLOW20": ts_mean(np.sign(r) * volume, 20) / np.maximum(ts_mean(volume, 20), 1e-9),
        "CRYPTO_TAIL20": ts_mean(np.minimum(r, 0) ** 2, 20) / np.maximum(ts_mean(r ** 2, 20), 1e-12),
        "CRYPTO_RANGE_POS20": _chan_pos(high, low, close, 20),
    }
    clock.update({name: _zscore_causal(a, 200) for name, a in raw.items()})
    clock.update(_direct_data_features(bars, r))
    return clock


def _masked_zscore_causal(values: np.ndarray, w: int) -> np.ndarray:
    """v2 掩码因果归一化:NaN 不参与滚动统计(方案 2.1-D / 5.2-4)

    旧 normalize 先把缺失填 0 参与滚动归一化——0 作为"真实观测"拉偏均值/
    方差,污染缺口邻域的有效 bar 统计。v2 规则:
    - 滚动窗内所有有效值参与统计,缺失不冒充 0;
    - min_periods = 完整窗口有效:窗内任一缺失(或头部不足整窗)→ NaN;
    - 全缺失序列 → 全 NaN(无效),不再返回常量 0。
    前缀含义随之修正:首个观测之前无信息,输出 NaN;追加未来有效数据不会
    让已有前缀从 0 变 NaN 或反之(旧口径的全缺失=0 歧义消除)。
    """
    values = np.asarray(values, dtype=float)
    n = len(values)
    good = np.isfinite(values)
    out = np.full(n, np.nan)
    if not good.any() or n == 0:
        return out
    x = np.where(good, values, 0.0)
    c = np.concatenate([[0.0], np.cumsum(x)])
    c2 = np.concatenate([[0.0], np.cumsum(x * x)])
    cnt = np.concatenate([[0], np.cumsum(good.astype(np.int64))])
    idx = np.arange(n)
    lo = np.maximum(0, idx - w + 1)
    span = idx - lo + 1
    n_in = cnt[idx + 1] - cnt[lo]
    full = n_in == span  # 窗内无缺失(头部部分窗口同样要求无缺失)
    s = c[idx + 1] - c[lo]
    s2 = c2[idx + 1] - c2[lo]
    with np.errstate(invalid="ignore", divide="ignore"):
        mean = s / span
        var = np.maximum(s2 / span - mean * mean, 0.0)
        std = np.sqrt(var)
        z = (x - mean) / np.maximum(std, 1e-8)
        out[full] = np.clip(z[full], -5.0, 5.0)
    return out


def _masked_mean(values: np.ndarray, w: int) -> np.ndarray:
    """因果滚动均值;窗口内有缺失(含头部部分窗口)记 NaN。

    不能直接用 ts_mean:cumsum 遇到一个 NaN 会把其后全部污染。
    """
    values = np.asarray(values, dtype=float)
    n = len(values)
    good = np.isfinite(values)
    c = np.concatenate([[0.0], np.cumsum(np.where(good, values, 0.0))])
    cnt = np.concatenate([[0], np.cumsum(good.astype(np.int64))])
    idx = np.arange(n)
    lo = np.maximum(0, idx - w + 1)
    span = idx - lo + 1
    out = (c[idx + 1] - c[lo]) / np.maximum(span, 1)
    out[(cnt[idx + 1] - cnt[lo]) != span] = np.nan
    return out


def _direct_data_features(bars, returns):
    """Append-only real exchange inputs. Missing is never interpreted as observed zero.

    Empty input rows are constant zero and unsampled. Partially missing rows carry
    NaN, which excludes them from training and rejects formulas on incomplete replay.
    Fixed windows preserve prefix invariance, including availability gaps.

    crypto_local_v2(is_v2)切换:_masked_zscore_causal —— 缺失不参与统计、
    全缺失返回 NaN(无效)而非常量 0;缺口后按完整窗口重新预热。
    """
    from .market import is_v2

    n = len(bars)
    v2 = is_v2(bars)
    def series(key):
        return np.array([float(b[key]) if b.get(key) is not None else np.nan for b in bars])
    def normalize(values):
        if v2:
            return _masked_zscore_causal(values, 200)
        good = np.isfinite(values)
        if not np.any(good):
            return np.zeros(n)
        normalized = _zscore_causal(np.where(good, values, 0.0), 200)
        return np.where(good, normalized, np.nan)
    funding = series("funding_rate")
    quote = series("quote_volume")
    flow = series("taker_imbalance")
    for i, b in enumerate(bars):
        # Spot K lines contain actual taker buy base volume for the same candle.
        if b.get("taker_buy_volume") is not None and b.get("volume") is not None:
            v, buy = float(b["volume"]), float(b["taker_buy_volume"])
            if v >= 0 and 0 <= buy <= v:
                flow[i] = 2 * buy / v - 1 if v > 0 else 0.0
    count = series("trade_count")
    # Causal rolling amount estimate; missing quote values invalidate that window.
    valid_quote = np.isfinite(quote) & (quote >= 0)
    illiq = ts_mean(np.abs(returns) / np.maximum(np.where(valid_quote, quote, 0), 1e-9), 20)
    illiq[ts_mean(valid_quote.astype(float), 20) < 1] = np.nan
    average = np.divide(quote, count, out=np.full(n, np.nan), where=count > 0)
    average[(count == 0) & (quote == 0)] = 0
    # 批次 59-61(append-only):永续合约持仓/资金费率的中周期结构。
    # 缺失(现货无 OI/funding)经 ts_mean 传播为 NaN,特征自动不可用。
    oi = series("open_interest")
    with np.errstate(invalid="ignore", divide="ignore"):
        log_oi = np.where(np.isfinite(oi) & (oi > 0), np.log(np.where(oi > 0, oi, 1.0)), np.nan)
    oi_chg24 = np.full(n, np.nan)
    if n > 24:
        oi_chg24[24:] = log_oi[24:] - log_oi[:-24]
    ret24 = _masked_mean(returns, 24) * 24
    return {
        "FUNDING_RATE": normalize(funding),
        "FUNDING_DELTA": normalize(funding - np.concatenate((funding[:1], funding[:-1]))),
        "TAKER_IMBALANCE": normalize(flow),
        "QUOTE_ILLIQ20": normalize(np.log(np.maximum(illiq, 1e-30))),
        "ACCOUNT_LS_RATIO": normalize(series("long_short_ratio")),
        "LIQUIDATION_IMBALANCE": normalize(series("liquidation_imbalance")),
        "AVG_TRADE_QUOTE": normalize(average),
        # 24 根资金费率均值:多头持续付费 = 拥挤,常见反转前兆
        "FUNDING_MEAN24": normalize(_masked_mean(funding, 24)),
        # 持仓变化 × 价格方向:同向 = 新资金顺势入场(趋势确认),
        # 反向 = 空头回补/多头平仓驱动(趋势衰竭)
        "OI_TREND24": normalize(oi_chg24 * np.sign(ret24)),
        # 24 根主动买卖不平衡均值:持续性订单流
        "TAKER_IMB24": normalize(_masked_mean(flow, 24)),
    }


def active_feature_ids(
    matrix: np.ndarray,
    crypto_profile: bool = False,
    max_head_gap: int | None = None,
) -> list[int]:
    """Training-only availability mask. IDs are never compacted/reassigned.

    v2(max_head_gap 非 None,方案 2.1-D):直连特征(≥52)允许"头部未采样"
    前缀——首个观测之前的缺失不是观测缺口,不计入污染;头部之后必须连续
    有效,中间缺口仍整项排除(首版不做跨缺口前填)。可容忍头部长度由
    max_head_gap 控制(调用方按 warmup 预算给定),超限特征不进搜索空间。
    """
    if not crypto_profile:
        return list(range(min(40, len(matrix))))
    excluded = {17, 18, 33, 34}
    active: list[int] = []
    for i, row in enumerate(matrix):
        if i in excluded:
            continue
        finite = np.isfinite(row)
        if not finite.any():
            continue  # 全缺失:无效(v1 常量 0 同样被 std 过滤,行为一致)
        if finite.all():
            head = 0
        else:
            first = int(np.argmax(finite))
            if max_head_gap is None:
                continue  # legacy:任一缺失整项排除(旧行为逐位一致)
            if not finite[first:].all():
                continue  # 中间缺口:整项排除
            head = first
            if head > max_head_gap:
                continue  # 头部超出预热预算:该特征本段不可用
        if float(np.std(row[finite] if head else row)) <= 1e-8:
            continue
        active.append(i)
    if not active:
        raise ValueError("No usable nonconstant training features")
    return active


FEATURE_NAMES: tuple[str, ...] = (
    "RET",
    "RET5",
    "RET20",
    "MA_DIFF",
    "SLOPE20",
    "ATR14",
    "RVOL",
    "HL_RANGE",
    "DEV",
    "RSI14",
    "AC1",
    "VOL_RATIO",
    "VOL_Z",
    "PV_CORR",
    # 以下为期货特有特征，只能追加在末尾（已有 token 的特征 id 不可变动）
    "OI_CHG",
    "OI_PV",
    "VOL_OI",
    "TOD",
    "NIGHT",
    # ── 扩容批次1（id 19-26）：K 线微观结构 + 长窗口 ──
    "GAP",
    "CLOSE_POS",
    "UPPER_SHADOW",
    "LOWER_SHADOW",
    "BODY",
    "RET60",
    "MA_DIFF60",
    "VOLAT_RATIO",
    # ── 扩容批次2（id 27-34）：量仓相关 / 高阶矩 / 日历 ──
    "OI_PC",
    "OI_CHG5",
    "OI_CHG20",
    "VOL_OI_MA",
    "SKEW20",
    "KURT20",
    "DOW",
    "DOM",
    # ── 扩容批次3(id 35):强弱值 ──
    "STRENGTH",
    # ── 桌面端本地专属(id 36-39):仅本地可执行,含此批次 token 的
    #    公式服务端无法回放,由 factor_local 打 local_only 标 ──
    "STREAK",
    "VWAP_DEV",
    "UPDOWN_VOL_RATIO",
    "CHAN_POS",
    # Crypto v1, append-only IDs 40-51. Windows are bars, not days.
    "UTC_HOUR_SIN", "UTC_HOUR_COS", "UTC_WEEK_SIN", "UTC_WEEK_COS", "UTC_WEEKEND",
    "CRYPTO_MOM6", "CRYPTO_MOM24", "CRYPTO_VOL20", "CRYPTO_ILLIQ20",
    "CRYPTO_FLOW20", "CRYPTO_TAIL20", "CRYPTO_RANGE_POS20",
    # Direct exchange inputs, IDs 52-58. No historical order-book proxies.
    "FUNDING_RATE", "FUNDING_DELTA", "TAKER_IMBALANCE", "QUOTE_ILLIQ20",
    "ACCOUNT_LS_RATIO", "LIQUIDATION_IMBALANCE", "AVG_TRADE_QUOTE",
    # Perp structure, IDs 59-61 (append-only; need gate_usdt funding/OI/taker).
    "FUNDING_MEAN24", "OI_TREND24", "TAKER_IMB24",
)


# ── 短线 v4 本地专属特征（shortline_v1；token 115-122 = 矩阵行 62-69）──
# 原始值由桌面回填管道按 bar 注入（键 sl_of0..7，来自 aggTrades 1 秒桶），
# 与桌面 TS 求值器 src/lib/shortline/orderflow.ts 同一冻结口径（见
# docs/plans/2026-09-30-shortline-lab-implementation.md §1）。
SHORTLINE_FEATURE_NAMES: tuple[str, ...] = (
    "SL_OF_IMB", "SL_BIG_SHARE", "SL_TRD_INT", "SL_PV_DIV",
    "SL_VWAP_DEV", "SL_BURST", "SL_STREAK_SIG", "SL_RHYTHM_ENT",
)
SHORTLINE_COLUMN_KEYS: tuple[str, ...] = tuple(f"sl_of{i}" for i in range(8))
SHORTLINE_ZSCORE_WINDOW = 300


def shortline_feature_rows(bars: list[dict[str, Any]]) -> dict[str, np.ndarray] | None:
    """v4 因果归一化行（masked zscore，窗 300）。

    bars 无任何 sl_of 列 → None（矩阵保持 62 行，旧口径逐位不变）。
    缺失（None/NaN）不冒充 0：全缺失行全 NaN，交 active_feature_ids 排除。
    """
    if not any(b.get(SHORTLINE_COLUMN_KEYS[0]) is not None for b in bars):
        return None
    out: dict[str, np.ndarray] = {}
    for i, key in enumerate(SHORTLINE_COLUMN_KEYS):
        values = np.array(
            [float(b[key]) if b.get(key) is not None else np.nan for b in bars],
            dtype=float,
        )
        out[SHORTLINE_FEATURE_NAMES[i]] = _masked_zscore_causal(values, SHORTLINE_ZSCORE_WINDOW)
    return out



# ── 特征矩阵按段缓存 ──────────────────────────────────────────
# feature_matrix 只取决于 bars，但调用方按「候选因子 × 段」组织循环，
# 同一个段会被不同 tokens 反复重算。walk_forward 的段级缓存键含 tokens，
# 拦不住这层重复：实测一次超级因子挖掘任务（pop=40 × gen=30、2000 根日线）
# 调用 feature_matrix 330 次而只有 12 个不同段（27.5× 冗余），且它占单次
# 冷段评估耗时的 99%。按段缓存后 search_stepwise 由 49.5s 降到 1.1s，
# 冠军 tokens 与 composite 逐位一致——纯计算复用，无语义变化。
#
# 上限按元素数而非条目数计：段长跨度大（日线数千根、walk-forward 各折
# 训练段逐折增长），条目数上限约束不住内存。4M 元素 ≈ 32MB float64——
# 实测一次 2000 根日线挖掘只占 12 条 / 24.9 万元素（约 2MB），预算只在
# 超深数据上才收紧；上限取保守值是因为同一份内核也跑在桌面端 Pyodide 里
# （浏览器堆更紧，且缓存驻留与该处的代际回收诉求相抵）。
#
# 实盘因子策略（ai_trading）每 2 秒按最新 bars 求一次信号，末根一变签名
# 即变，基本恒为未命中——它只付一次字典查找的代价，并会挤占缓存。挖掘
# 侧不受影响：挖掘每代都重复命中自己那十几个段，LRU 次序被持续刷新，
# 驻留优先级高于只写一次的实盘条目；最坏情况也只是 32MB 上限内的浪费。
_MATRIX_CACHE: OrderedDict[tuple, np.ndarray] = OrderedDict()
# 64MB 元素预算:15m 深历史一条 [62, ~17k] f64 ≈ 8.5MB,严格筛/_enrich 一代
# 要用 ~8 种切片上下文(全段/训练/测试/OOS 四分/WF 折),4M(32MB)只驻 3 条,
# 跨代 LRU 抖动导致每代全量重算(实测占精算耗时 80%+);64MB 可驻 ~7 条,
# 切片集合跨代稳定后基本全命中。池 worker 只用固定全段 1 条,不受影响。
_MATRIX_CACHE_MAX_ELEMENTS = 8_000_000
# 深数据自适应预算的硬顶(24M 元素 ≈ 192MB/实例):见 _evict_matrix_cache
_MATRIX_CACHE_HARD_CAP = 24_000_000


def bars_signature(bars: list[dict[str, Any]]) -> tuple:
    """段签名 —— 按段缓存的键

    哈希全部特征输入与市场标记；修正中间 bar 的量/价也必须使缓存失效。
    """
    if not bars:
        return (0,)
    import hashlib
    keys = ("time", "open", "high", "low", "close", "volume", "open_interest", "_factor_market", "funding_rate", "quote_volume",
            "taker_imbalance", "taker_buy_volume", "trade_count", "long_short_ratio", "liquidation_imbalance") + SHORTLINE_COLUMN_KEYS
    digest = hashlib.sha256()
    for b in bars:
        digest.update(repr(tuple(b.get(k) for k in keys)).encode("utf-8"))
    return (len(bars), digest.digest())


# ── 签名 id 快键 ────────────────────────────────────────────
# O(N) 签名对冻结 bars(会话/任务快照,全内核只读约定)是确定性的:按
# (id, len) 复用签名,值持 bars 引用防 id 复用。_dedup_top 的 corr 段与
# feature_matrix 曾各哈希一次,分片评估的新鲜 train 前缀每调用再哈希一次
# ——深数据单次 0.5-1s(原生),全部由本快键消除。
_SIG_CACHE: OrderedDict[tuple, tuple] = OrderedDict()
_SIG_CACHE_MAX = 32


def signature_of(bars: list[dict[str, Any]]) -> tuple:
    """bars_signature 的冻结对象快键:同一 list 跨调用零重算"""
    key = (id(bars), len(bars))
    hit = _SIG_CACHE.get(key)
    if hit is not None:
        _SIG_CACHE.move_to_end(key)
        bars_ref, sig = hit
        if bars_ref is bars:
            return sig
    sig = bars_signature(bars)
    _SIG_CACHE[key] = (bars, sig)
    while len(_SIG_CACHE) > _SIG_CACHE_MAX:
        _SIG_CACHE.popitem(last=False)
    return sig


# ── 前缀矩阵快键 ────────────────────────────────────────────
# 全上下文切片(crypto 恒为前缀 bars[:hi])的矩阵可由全量矩阵列视图零拷贝
# 获得:特征全为因果(只用历史,scripts/verify-frozen-view 前缀验证逐位
# 一致),matrix(bars[:n]) ≡ matrix(bars)[:, :n]。深数据一次搜索要用
# ~8 种前缀切片(训练/测试/OOS 四分/WF 折),逐条 compute_features 实测
# 每代 25s+(72k 根);走本快键后每份冻结 bars 只算一次全量矩阵。
# 值持 bars 引用防 id 复用。
_PREFIX_CACHE: OrderedDict[tuple, tuple] = OrderedDict()
_PREFIX_CACHE_MAX = 4


def prefix_matrix(bars: list[dict[str, Any]]) -> np.ndarray:
    """冻结 bars 的全量特征矩阵(前缀视图的母体)"""
    key = (id(bars), len(bars))
    hit = _PREFIX_CACHE.get(key)
    if hit is not None:
        _PREFIX_CACHE.move_to_end(key)
        bars_ref, mat = hit
        if bars_ref is bars:
            return mat
    mat = feature_matrix(bars, _sig=signature_of(bars))
    _PREFIX_CACHE[key] = (bars, mat)
    while len(_PREFIX_CACHE) > _PREFIX_CACHE_MAX:
        _PREFIX_CACHE.popitem(last=False)
    return mat


def prefix_view_matrix(bars: list[dict[str, Any]], n: int) -> np.ndarray:
    """bars[:n] 的特征矩阵:全量矩阵的列视图(要求 bars 为冻结只读对象)"""
    if n >= len(bars):
        return prefix_matrix(bars)
    full = prefix_matrix(bars)
    if n > full.shape[1]:
        return full
    return full[:, :n]


def seed_matrix(sig: tuple, mat: np.ndarray) -> None:
    """把前缀视图产出的矩阵按内容签名登记进段缓存

    regime_decompose 等按 (ctx 内容签名) 查 feature_matrix 的调用方,
    与 evaluate_on_slice 的前缀路径算的是同一份内容:登记后互相命中,
    不再各自重算。视图与母体共享缓冲,零额外内存。
    """
    if sig is None or _MATRIX_CACHE.get(sig) is not None:
        return
    _MATRIX_CACHE[sig] = mat
    _MATRIX_CACHE.move_to_end(sig)
    _evict_matrix_cache(int(mat.size))



def _evict_matrix_cache(current_size: int = 0) -> None:
    """按元素预算淘汰最久未用的段（至少保留刚写入的一条）

    预算自适应:一代严格筛/_enrich 要用 ~8 种切片上下文(全段/训练/测试/
    OOS 四分/WF 折),深数据单条矩阵 4M+ 元素时固定 8M 只驻 2 条,跨代
    LRU 抖动导致每代重算 compute_features(72k 根实测每代多耗 25s+)。
    预算按当前矩阵规模 ×5 放大(≈覆盖一代上下文集合),硬顶 24M(192MB)
    防深历史内存无界;浅数据维持 8M 原行为不变。
    """
    budget = min(
        _MATRIX_CACHE_HARD_CAP,
        max(_MATRIX_CACHE_MAX_ELEMENTS, 5 * max(current_size, 1)),
    )
    total = sum(int(m.size) for m in _MATRIX_CACHE.values())
    while len(_MATRIX_CACHE) > 1 and total > budget:
        _, dropped = _MATRIX_CACHE.popitem(last=False)
        total -= int(dropped.size)


def clear_feature_matrix_cache() -> None:
    """清空特征矩阵缓存（测试隔离用）"""
    _MATRIX_CACHE.clear()


def feature_matrix(bars: list[dict[str, Any]], _sig: tuple | None = None) -> np.ndarray:
    """返回 [F, T] 特征矩阵，顺序与 FEATURE_NAMES 一致

    结果按段缓存，返回只读数组（调用方只按行取特征送入 StackVM，
    不写入矩阵；只读标记把将来的意外写入变成显式报错而非静默串数据）。
    _sig:调用方已算好的 bars 签名(walk_forward 的切片快键),免去此处
    对同一 ctx 的 O(N) 重复哈希;签名必须确为该 bars 的 bars_signature。
    """
    key = _sig if _sig is not None else bars_signature(bars)
    hit = _MATRIX_CACHE.get(key)
    if hit is not None:
        _MATRIX_CACHE.move_to_end(key)
        return hit
    feats = compute_features(bars)
    rows = [feats[name] for name in FEATURE_NAMES]
    shortline = shortline_feature_rows(bars)
    if shortline is not None:
        rows.extend(shortline[name] for name in SHORTLINE_FEATURE_NAMES)
    matrix = np.vstack(rows)
    matrix.flags.writeable = False
    _MATRIX_CACHE[key] = matrix
    _MATRIX_CACHE.move_to_end(key)
    _evict_matrix_cache(int(matrix.size))
    return matrix
