"""特征组合 —— compute_features 与 FEATURE_NAMES（append-only）

自单文件 features.py 拆出（2026-08-31，行为零变化）。
所有特征严格因果（只用当前及历史 bar），无未来函数。
价量类特征经因果 zscore 归一化并 clip[-5,5]；
时间类特征本身已在 [-1,1] 且带日内周期语义，不做 zscore
（200 根窗口在 1m 上不足一个交易日，zscore 会把日内周期抹平）。

特征顺序由 FEATURE_NAMES 固定，VM 据此索引。新增特征只能追加在末尾，
且不会影响算子 token（特征 id 空间已冻结，见 token_encoding.py）。
"""

from __future__ import annotations

from typing import Any

import numpy as np

from ..ops import delta, ts_corr, ts_mean, ts_std
from .calendar import (
    _dow_dom,
    _is_night,
    _is_us_session,
    _is_weekend,
    _time_of_day,
    _time_of_day24,
)
from .primitives import (
    _ac1,
    _atr,
    _btc_ret,
    _ffill_field,
    _open_interest,
    _ret,
    _rolling_moment,
    _rsi,
    _to_arr,
    _zscore_causal,
    zscore_window,
)
from .strength import strength_series
from .ta import (
    adx,
    amihud,
    cmf,
    donchian_pos,
    garman_klass,
    jump_freq,
    macd,
    mfi,
    parkinson,
    semivol_ratio,
    vwap_dev,
    vol_of_vol,
)


def compute_features(bars: list[dict[str, Any]], *, normalization_window: int | None = None) -> dict[str, np.ndarray]:
    """计算全部特征，返回 name -> [T] 因果归一化数组"""
    close = _to_arr(bars, "close")
    high = _to_arr(bars, "high")
    low = _to_arr(bars, "low")
    open_ = _to_arr(bars, "open")
    volume = _to_arr(bars, "volume").astype(float)
    open_interest, has_oi = _open_interest(bars)
    funding, has_funding = _ffill_field(bars, "funding_rate")
    lsr, has_lsr = _ffill_field(bars, "lsr")
    taker, has_taker = _ffill_field(bars, "taker_ratio")
    xspread, has_xspread = _ffill_field(bars, "xspread")
    btc_ret, has_btc = _btc_ret(bars)

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
        # ── 扩容批次3（id 35）：强弱值（图表强弱指标同口径，默认参数）──
        "STRENGTH": strength_series(bars),
        # ── 扩容批次4（id 36-47，A 级纯 OHLCV）：经典 TA / 区间波动 / 量价流动 ──
        # 趋势
        "MACD": macd(close),
        "ADX14": adx(high, low, close, 14),
        "DONCH20": donchian_pos(high, low, close, 20),
        # 区间波动估计量（比收盘价波动高效；GK 不做 Yang-Zhang——7×24 无隔夜）
        "PARKINSON20": parkinson(high, low, 20),
        "GK20": garman_klass(high, low, open_, close, 20),
        # 波动结构
        "SEMIVOL20": semivol_ratio(close, 20),
        "VOV20": vol_of_vol(close, 20),
        "JUMP20": jump_freq(close, 20),
        # 量价流动性
        "VWAP_DEV20": vwap_dev(high, low, close, volume, 20),
        "AMIHUD20": amihud(close, volume, 20),
        "MFI14": mfi(high, low, close, volume, 14),
        "CMF20": cmf(high, low, close, volume, 20),
        # ── 扩容批次5（id 51-53，B 级衍生品 + P4 跨资产；bars 由
        #    services/deriv_history.enrich_factor_bars 富化注入，缺数据置零）──
        # 资金费率水平（拥挤杠杆方向代理；变化/均值偏离由算子在特征上组合）
        "FUNDING": funding if has_funding else zeros,
        # BTC 市场因子与特质（超额）动量
        "BTC_RET": btc_ret if has_btc else zeros,
        "EXCESS_RET": (
            _ret(close, 1) - btc_ret if has_btc else zeros
        ),
        # ── 扩容批次6（id 54-56，B 级补齐：情绪/流向/跨所）──
        # 多空比（账户口径，>1 = 散户多头拥挤，常作反向指标）
        "LSR": lsr if has_lsr else zeros,
        # 主动买占比（taker buy/(buy+sell)，0.5 中性——订单流不平衡）
        "TAKER": taker if has_taker else zeros,
        # 跨所价差（其它所对 OKX 的溢价均值，跨所资金流压力）
        "XSPREAD": xspread if has_xspread else zeros,
    }
    # 价量类做因果归一化（窗口至少覆盖一个完整交易日）
    window = normalization_window if normalization_window is not None else zscore_window(bars)
    out = {name: _zscore_causal(arr, window) for name, arr in raw.items()}
    # 时间类已在 [-1,1] 且带日内周期语义，zscore 会把周期抹平，故不归一化
    out["TOD"] = _time_of_day(bars)
    out["NIGHT"] = _is_night(bars)
    # 日历类同理：周期语义值，zscore 会抹平周内效应
    dow, dom = _dow_dom(bars)
    out["DOW"] = dow
    out["DOM"] = dom
    # ── 扩容批次4（id 48-50）：加密口径日历（7×24） ──
    out["TOD24"] = _time_of_day24(bars)
    out["US_SESSION"] = _is_us_session(bars)
    out["WEEKEND"] = _is_weekend(bars)
    # ── v3 桌面端谱系特征（id 57-82）：与桌面端 pykernel features.py 同名同义。
    #    不进服务器侧搜索池（SEARCH_EXCLUDED 之外单独标记），仅供桌面端
    #    挖掘产物的 v3 token 挂载回放。 ──
    out.update(
        _desktop_features(
            bars, close, high, low, volume,
            funding=funding, has_funding=has_funding,
            lsr=lsr, has_lsr=has_lsr,
            taker=taker, has_taker=has_taker,
        )
    )
    return out


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
    # ── 扩容批次3（id 35）：强弱值 ──
    "STRENGTH",
    # ── 扩容批次4（id 36-47，A 级纯 OHLCV）：经典 TA / 区间波动 / 量价流动 ──
    "MACD",
    "ADX14",
    "DONCH20",
    "PARKINSON20",
    "GK20",
    "SEMIVOL20",
    "VOV20",
    "JUMP20",
    "VWAP_DEV20",
    "AMIHUD20",
    "MFI14",
    "CMF20",
    # ── 扩容批次4（id 48-50）：加密口径日历（7×24） ──
    "TOD24",
    "US_SESSION",
    "WEEKEND",
    # ── 扩容批次5（id 51-53）：B 级衍生品 + P4 跨资产 ──
    "FUNDING",
    "BTC_RET",
    "EXCESS_RET",
    # ── 扩容批次6（id 54-56）：B 级补齐（情绪/流向/跨所） ──
    "LSR",
    "TAKER",
    "XSPREAD",
    # ── v3 桌面端谱系特征（id 57-82）：仅 v3 token（>=128）可达，
    #    v2 公式永远取不到这些行，append 不影响任何存量语义 ──
    "STREAK",
    "VWAP_DEV",
    "UPDOWN_VOL_RATIO",
    "CHAN_POS",
    "UTC_HOUR_SIN",
    "UTC_HOUR_COS",
    "UTC_WEEK_SIN",
    "UTC_WEEK_COS",
    "UTC_WEEKEND",
    "CRYPTO_MOM6",
    "CRYPTO_MOM24",
    "CRYPTO_VOL20",
    "CRYPTO_ILLIQ20",
    "CRYPTO_FLOW20",
    "CRYPTO_TAIL20",
    "CRYPTO_RANGE_POS20",
    "FUNDING_RATE",
    "FUNDING_DELTA",
    "TAKER_IMBALANCE",
    "QUOTE_ILLIQ20",
    "ACCOUNT_LS_RATIO",
    "LIQUIDATION_IMBALANCE",
    "AVG_TRADE_QUOTE",
    "FUNDING_MEAN24",
    "OI_TREND24",
    "TAKER_IMB24",
)

# ── 搜索空间屏蔽（2026-09 加密化） ──────────────────────────
# 期货口径遗留特征：实现冻结（存量 token 语义不可变，收藏/历史/AI 任务
# 里的旧公式仍按原样执行），但不再进入新搜索的随机特征池——
#   TOD/NIGHT：期货夜盘会话口径（21:00 起点、15:00~21:00 平顶），
#              加密替代品 TOD24/US_SESSION
#   DOW：周一~五映射，周六日溢出 [-1,1]，破坏「时间类不再归一化」前提，
#        加密替代品 WEEKEND（周内效应弱于周末流动性效应）
# DOM（月内位置）口径在 7×24 下仍然成立，保留在搜索池中。
# 只影响 GP 随机生成/变异与 LLM 提示词的特征清单，不影响 VM 执行合法性。
SEARCH_EXCLUDED_FEATURES: frozenset[str] = frozenset(
    {"TOD", "NIGHT", "DOW"}
)


def searchable_feature_ids() -> list[int]:
    """新搜索可用的特征 id 池（排除期货口径遗留特征）"""
    return [
        i for i, name in enumerate(FEATURE_NAMES)
        if name not in SEARCH_EXCLUDED_FEATURES
    ]


# ── v3 桌面端谱系特征实现（id 57-82）──────────────────────────
# 实现逐条镜像桌面端 public/pykernel/factor_lab/features.py：
# 桌面端挖掘评分与服务器实盘信号必须同口径，公式值才可比。
# 直连类字段按服务器富化管道适配：taker_ratio(0-1)→imbalance(2r-1)、
# lsr→long_short_ratio；quote_volume/trade_count/liquidation_imbalance
# 服务器无源 → 对应特征全 NaN（缺失，不算 0 观测）。


def _desktop_utc(value: str):
    """bar 时间串 → UTC datetime（无时区按北京时间，纯日期按 UTC）

    与桌面端 market.utc_time 同语义；服务器 K 线 time 为北京时间字符串。
    """
    from datetime import datetime, timedelta, timezone as _tz

    try:
        dt = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None
    if dt.tzinfo is None:
        naive_utc = _tz.utc if len(str(value)) == 10 else _tz(timedelta(hours=8))
        dt = dt.replace(tzinfo=naive_utc)
    return dt.astimezone(_tz.utc)


def _desktop_streak(close: np.ndarray, cap: int = 12) -> np.ndarray:
    """连续同向收盘计数(路径依赖):方向 × min(连涨/连跌根数, cap) / cap"""
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


def _desktop_vwap_dev(
    high: np.ndarray, low: np.ndarray, close: np.ndarray, volume: np.ndarray, w: int = 20
) -> np.ndarray:
    """收盘对量加权典型价均线的偏离"""
    tp = (high + low + close) / 3.0
    vwap = ts_mean(tp * volume, w) / np.maximum(ts_mean(volume, w), 1e-9)
    return (close - vwap) / np.maximum(np.abs(vwap), 1e-9)


def _desktop_updown_vol_ratio(close: np.ndarray, w: int = 20) -> np.ndarray:
    """上行/下行收益波动占比:(E[up²]−E[dn²])/(E[up²]+E[dn²]) ∈ [−1,1]"""
    r = _ret(close, 1)
    up = np.where(r > 0, r, 0.0)
    dn = np.where(r < 0, -r, 0.0)
    su = ts_mean(up * up, w)
    sd = ts_mean(dn * dn, w)
    return (su - sd) / np.maximum(su + sd, 1e-12)


def _desktop_chan_pos(
    high: np.ndarray, low: np.ndarray, close: np.ndarray, w: int = 20
) -> np.ndarray:
    """收盘在 w 根高低通道内的位置,映射 [−1,1](下轨 −1 / 上轨 +1)"""
    from ..ops import ts_max, ts_min

    hh = ts_max(high, w)
    ll = ts_min(low, w)
    return (close - ll) / np.maximum(hh - ll, 1e-9) * 2.0 - 1.0


def _desktop_masked_zscore(values: np.ndarray, w: int = 200) -> np.ndarray:
    """缺失容忍因果 zscore：NaN 不参与统计、窗内任一缺失记 NaN（clip ±5）"""
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
    full = n_in == span
    s = c[idx + 1] - c[lo]
    s2 = c2[idx + 1] - c2[lo]
    with np.errstate(invalid="ignore", divide="ignore"):
        mean = s / span
        var = np.maximum(s2 / span - mean * mean, 0.0)
        std = np.sqrt(var)
        z = (x - mean) / np.maximum(std, 1e-8)
        out[full] = np.clip(z[full], -5.0, 5.0)
    return out


def _desktop_masked_mean(values: np.ndarray, w: int) -> np.ndarray:
    """因果滚动均值;窗口内有缺失(含头部部分窗口)记 NaN"""
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


def _desktop_norm_window(bars: list[dict[str, Any]]) -> int:
    """桌面 v2 前缀不变归一化窗口：头部 bar 间距中位数推导日内密度

    与桌面端 research_context.norm_window_for_bars 同款（v2 契约）；
    间距解析失败回落 200。服务器主链 zscore_window 是交易日口径
    （len/天数，前缀可变），与桌面加密路径不一致，故此处独立实现。
    """
    from datetime import datetime as _dt

    base = 200
    if len(bars) < 3:
        return base
    gaps: list[float] = []
    for i in range(1, min(6, len(bars))):
        try:
            a = _dt.fromisoformat(str(bars[i - 1].get("time") or "")[:19])
            b = _dt.fromisoformat(str(bars[i].get("time") or "")[:19])
        except ValueError:
            continue
        sec = (b - a).total_seconds()
        if sec > 0:
            gaps.append(sec)
    if not gaps:
        return base
    gap = sorted(gaps)[len(gaps) // 2]
    per_day = 86400.0 / gap
    return max(base, int(per_day + 0.999999))


def _desktop_features(
    bars: list[dict[str, Any]],
    close: np.ndarray,
    high: np.ndarray,
    low: np.ndarray,
    volume: np.ndarray,
    *,
    funding: np.ndarray,
    has_funding: bool,
    lsr: np.ndarray,
    has_lsr: bool,
    taker: np.ndarray,
    has_taker: bool,
) -> dict[str, np.ndarray]:
    from ..ops import ts_std

    n = len(bars)
    nan = np.full(n, np.nan)
    window = _desktop_norm_window(bars)

    # 桌面 id 36-39：K 线结构（走 zscore_window，与桌面 raw dict 统一归一一致）
    struct = {
        "STREAK": _desktop_streak(close),
        "VWAP_DEV": _desktop_vwap_dev(high, low, close, volume),
        "UPDOWN_VOL_RATIO": _desktop_updown_vol_ratio(close),
        "CHAN_POS": _desktop_chan_pos(high, low, close),
    }

    # 桌面 id 40-44：UTC 时钟（[-1,1] 周期语义，不归一化）
    clock = {
        k: np.zeros(n)
        for k in ("UTC_HOUR_SIN", "UTC_HOUR_COS", "UTC_WEEK_SIN", "UTC_WEEK_COS", "UTC_WEEKEND")
    }
    for i, bar in enumerate(bars):
        dt = _desktop_utc(str(bar.get("time") or ""))
        if dt is None:
            continue
        if len(str(bar.get("time") or "")) > 10:
            phase = 2 * np.pi * (dt.hour * 60 + dt.minute) / 1440
            clock["UTC_HOUR_SIN"][i] = np.sin(phase)
            clock["UTC_HOUR_COS"][i] = np.cos(phase)
        phase = 2 * np.pi * dt.weekday() / 7
        clock["UTC_WEEK_SIN"][i] = np.sin(phase)
        clock["UTC_WEEK_COS"][i] = np.cos(phase)
        clock["UTC_WEEKEND"][i] = float(dt.weekday() >= 5)
    clock = {name: np.round(values, 7) for name, values in clock.items()}

    # 桌面 id 45-51：crypto 批次（zscore 200 固定窗）
    r = _ret(close, 1)
    vol = ts_std(r, 20)
    amount = np.maximum(close * volume, 1e-9)
    crypto = {
        "CRYPTO_MOM6": _ret(close, 6) / np.maximum(vol * np.sqrt(6), 1e-8),
        "CRYPTO_MOM24": _ret(close, 24) / np.maximum(vol * np.sqrt(24), 1e-8),
        "CRYPTO_VOL20": vol,
        "CRYPTO_ILLIQ20": np.log(np.maximum(ts_mean(np.abs(r) / amount, 20), 1e-30)),
        "CRYPTO_FLOW20": ts_mean(np.sign(r) * volume, 20) / np.maximum(ts_mean(volume, 20), 1e-9),
        "CRYPTO_TAIL20": ts_mean(np.minimum(r, 0) ** 2, 20) / np.maximum(ts_mean(r ** 2, 20), 1e-12),
        "CRYPTO_RANGE_POS20": _desktop_chan_pos(high, low, close, 20),
    }
    clock.update({name: _zscore_causal(a, 200) for name, a in crypto.items()})

    # 桌面 id 52-61：直连输入（服务器字段适配；无源特征全 NaN=缺失）
    def _masked(field: np.ndarray, has: bool) -> np.ndarray:
        return field if has else nan

    imb = 2.0 * taker - 1.0  # taker_ratio∈[0,1] → imbalance∈[-1,1]
    flow = _masked(imb, has_taker)
    oi, has_oi = _open_interest(bars)
    if has_oi:
        with np.errstate(invalid="ignore", divide="ignore"):
            log_oi = np.where(np.isfinite(oi) & (oi > 0), np.log(np.where(oi > 0, oi, 1.0)), np.nan)
        oi_chg24 = np.full(n, np.nan)
        if n > 24:
            oi_chg24[24:] = log_oi[24:] - log_oi[:-24]
    else:
        oi_chg24 = nan
    fund = _masked(funding, has_funding)
    ret24 = _desktop_masked_mean(r, 24) * 24

    direct = {
        "FUNDING_RATE": _desktop_masked_zscore(fund),
        "FUNDING_DELTA": _desktop_masked_zscore(
            fund - np.concatenate((fund[:1], fund[:-1]))
        ),
        "TAKER_IMBALANCE": _desktop_masked_zscore(flow),
        "QUOTE_ILLIQ20": nan,  # 服务器无逐笔成交额，缺失
        "ACCOUNT_LS_RATIO": _desktop_masked_zscore(_masked(lsr, has_lsr)),
        "LIQUIDATION_IMBALANCE": nan,  # 服务器无强平流数据，缺失
        "AVG_TRADE_QUOTE": nan,  # 服务器无逐笔笔数，缺失
        "FUNDING_MEAN24": _desktop_masked_zscore(_desktop_masked_mean(fund, 24)),
        "OI_TREND24": _desktop_masked_zscore(oi_chg24 * np.sign(ret24)),
        "TAKER_IMB24": _desktop_masked_zscore(_desktop_masked_mean(flow, 24)),
    }

    out = {name: _zscore_causal(arr, window) for name, arr in struct.items()}
    out.update(clock)
    out.update(direct)
    return out


# Generated selective replay path; full feature calculation stays available.
def compute_selected_features(bars: list[dict[str, Any]], *, normalization_window: int | None=None, needed_names=None) -> dict[str, np.ndarray]:
    """计算全部特征，返回 name -> [T] 因果归一化数组"""
    close = _to_arr(bars, 'close')
    high = _to_arr(bars, 'high')
    low = _to_arr(bars, 'low')
    open_ = _to_arr(bars, 'open')
    volume = _to_arr(bars, 'volume').astype(float)
    (open_interest, has_oi) = _open_interest(bars)
    (funding, has_funding) = _ffill_field(bars, 'funding_rate')
    (lsr, has_lsr) = _ffill_field(bars, 'lsr')
    (taker, has_taker) = _ffill_field(bars, 'taker_ratio')
    (xspread, has_xspread) = _ffill_field(bars, 'xspread')
    (btc_ret, has_btc) = _btc_ret(bars)
    ma20 = ts_mean(close, 20)
    std20 = ts_std(close, 20)
    ma60 = ts_mean(close, 60)
    std60 = ts_std(close, 60)
    vol_ma = ts_mean(volume, 20)
    vol_std = ts_std(volume, 20)
    zeros = np.zeros_like(close)
    oi_delta = delta(open_interest, 1)
    rng = np.maximum(high - low, 1e-09)
    gap = np.zeros_like(close)
    gap[1:] = (open_[1:] - close[:-1]) / np.maximum(np.abs(close[:-1]), 1e-09)
    raw: dict[str, np.ndarray] = {'RET': lambda : _ret(close, 1), 'RET5': lambda : _ret(close, 5), 'RET20': lambda : _ret(close, 20), 'MA_DIFF': lambda : (close - ma20) / np.maximum(np.abs(ma20), 1e-09), 'SLOPE20': lambda : delta(ma20, 5) / np.maximum(np.abs(ma20), 1e-09), 'ATR14': lambda : _atr(high, low, close, 14) / np.maximum(close, 1e-09), 'RVOL': lambda : vol_std / np.maximum(vol_ma, 1e-09), 'HL_RANGE': lambda : (high - low) / np.maximum(close, 1e-09), 'DEV': lambda : (close - ma20) / np.maximum(std20, 1e-09), 'RSI14': lambda : _rsi(close, 14), 'AC1': lambda : _ac1(close, 20), 'VOL_RATIO': lambda : volume / np.maximum(vol_ma, 1e-09), 'VOL_Z': lambda : (volume - vol_ma) / np.maximum(vol_std, 1e-09), 'PV_CORR': lambda : ts_corr(_ret(close, 1), volume, 20), 'OI_CHG': lambda : oi_delta / np.maximum(np.abs(open_interest), 1.0) if has_oi else zeros, 'OI_PV': lambda : np.sign(_ret(close, 1)) * np.sign(oi_delta) if has_oi else zeros, 'VOL_OI': lambda : volume / np.maximum(open_interest, 1.0) if has_oi else zeros, 'GAP': lambda : gap, 'CLOSE_POS': lambda : (close - low) / rng, 'UPPER_SHADOW': lambda : (high - np.maximum(open_, close)) / np.maximum(close, 1e-09), 'LOWER_SHADOW': lambda : (np.minimum(open_, close) - low) / np.maximum(close, 1e-09), 'BODY': lambda : (close - open_) / np.maximum(close, 1e-09), 'RET60': lambda : _ret(close, 60), 'MA_DIFF60': lambda : (close - ma60) / np.maximum(np.abs(ma60), 1e-09), 'VOLAT_RATIO': lambda : std20 / np.maximum(std60, 1e-09), 'OI_PC': lambda : ts_corr(_ret(close, 1), oi_delta, 20) if has_oi else zeros, 'OI_CHG5': lambda : delta(open_interest, 5) / np.maximum(np.abs(open_interest), 1.0) if has_oi else zeros, 'OI_CHG20': lambda : delta(open_interest, 20) / np.maximum(np.abs(open_interest), 1.0) if has_oi else zeros, 'VOL_OI_MA': lambda : ts_mean(volume / np.maximum(open_interest, 1.0), 20) if has_oi else zeros, 'SKEW20': lambda : _rolling_moment(_ret(close, 1), 20, 3), 'KURT20': lambda : _rolling_moment(_ret(close, 1), 20, 4), 'STRENGTH': lambda : strength_series(bars), 'MACD': lambda : macd(close), 'ADX14': lambda : adx(high, low, close, 14), 'DONCH20': lambda : donchian_pos(high, low, close, 20), 'PARKINSON20': lambda : parkinson(high, low, 20), 'GK20': lambda : garman_klass(high, low, open_, close, 20), 'SEMIVOL20': lambda : semivol_ratio(close, 20), 'VOV20': lambda : vol_of_vol(close, 20), 'JUMP20': lambda : jump_freq(close, 20), 'VWAP_DEV20': lambda : vwap_dev(high, low, close, volume, 20), 'AMIHUD20': lambda : amihud(close, volume, 20), 'MFI14': lambda : mfi(high, low, close, volume, 14), 'CMF20': lambda : cmf(high, low, close, volume, 20), 'FUNDING': lambda : funding if has_funding else zeros, 'BTC_RET': lambda : btc_ret if has_btc else zeros, 'EXCESS_RET': lambda : _ret(close, 1) - btc_ret if has_btc else zeros, 'LSR': lambda : lsr if has_lsr else zeros, 'TAKER': lambda : taker if has_taker else zeros, 'XSPREAD': lambda : xspread if has_xspread else zeros}
    window = normalization_window if normalization_window is not None else zscore_window(bars)
    out = {name: _zscore_causal(arr(), window) for (name, arr) in raw.items() if needed_names is None or name in needed_names}
    out['TOD'] = _time_of_day(bars)
    out['NIGHT'] = _is_night(bars)
    (dow, dom) = _dow_dom(bars)
    out['DOW'] = dow
    out['DOM'] = dom
    out['TOD24'] = _time_of_day24(bars)
    out['US_SESSION'] = _is_us_session(bars)
    out['WEEKEND'] = _is_weekend(bars)
    if needed_names is None or any((name in needed_names for name in FEATURE_NAMES[57:])):
        out.update(_desktop_features(bars, close, high, low, volume, funding=funding, has_funding=has_funding, lsr=lsr, has_lsr=has_lsr, taker=taker, has_taker=has_taker))
    return out
