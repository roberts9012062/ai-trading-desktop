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
    return clock


def active_feature_ids(matrix: np.ndarray, crypto_profile: bool = False) -> list[int]:
    """Training-only availability mask. IDs are never compacted/reassigned."""
    if not crypto_profile:
        return list(range(min(40, len(matrix))))
    excluded = {17, 18, 33, 34}
    active = [i for i, row in enumerate(matrix)
              if i not in excluded and np.isfinite(row).all() and np.std(row) > 1e-8]
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
)


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
_MATRIX_CACHE_MAX_ELEMENTS = 4_000_000


def bars_signature(bars: list[dict[str, Any]]) -> tuple:
    """段签名 —— 按段缓存的键

    哈希全部特征输入与市场标记；修正中间 bar 的量/价也必须使缓存失效。
    """
    if not bars:
        return (0,)
    import hashlib
    keys = ("time", "open", "high", "low", "close", "volume", "open_interest", "_factor_market")
    digest = hashlib.sha256()
    for b in bars:
        digest.update(repr(tuple(b.get(k) for k in keys)).encode("utf-8"))
    return (len(bars), digest.digest())



def _evict_matrix_cache() -> None:
    """按元素预算淘汰最久未用的段（至少保留刚写入的一条）"""
    total = sum(int(m.size) for m in _MATRIX_CACHE.values())
    while len(_MATRIX_CACHE) > 1 and total > _MATRIX_CACHE_MAX_ELEMENTS:
        _, dropped = _MATRIX_CACHE.popitem(last=False)
        total -= int(dropped.size)


def clear_feature_matrix_cache() -> None:
    """清空特征矩阵缓存（测试隔离用）"""
    _MATRIX_CACHE.clear()


def feature_matrix(bars: list[dict[str, Any]]) -> np.ndarray:
    """返回 [F, T] 特征矩阵，顺序与 FEATURE_NAMES 一致

    结果按段缓存，返回只读数组（调用方只按行取特征送入 StackVM，
    不写入矩阵；只读标记把将来的意外写入变成显式报错而非静默串数据）。
    """
    key = bars_signature(bars)
    hit = _MATRIX_CACHE.get(key)
    if hit is not None:
        _MATRIX_CACHE.move_to_end(key)
        return hit
    feats = compute_features(bars)
    matrix = np.vstack([feats[name] for name in FEATURE_NAMES])
    matrix.flags.writeable = False
    _MATRIX_CACHE[key] = matrix
    _MATRIX_CACHE.move_to_end(key)
    _evict_matrix_cache()
    return matrix
