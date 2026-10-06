"""年化基数推导 —— 按周期实测每年 bar 数

背景：因子评估原先把年化基数硬编码为 243（国内期货交易日数），
分钟周期沿用该值会把年化收益、Sortino、Calmar 一起压平：

    1m ≈ 84000 bar/年，用 243 → 年化低估约 345 倍
    5m ≈ 16800 → 约 69 倍       15m ≈ 5600 → 约 23 倍
    30m ≈ 2800 → 约 12 倍       60m ≈ 1400 → 约 6 倍

composite 适应度里收益项（ann/sortino/calmar 合计权重 0.75）被压到接近 0，
而对称性/换手/一致性是 O(1) 量级不受影响，遗传搜索在短周期上
实际变成了「优化多空对称与低换手」，这是短周期挖掘年率偏低的主因。

加密口径修正（2026-09）：系统已全面 7×24 化，年化天数从期货的 243
交易日改为自然年 365 天，兜底会话分钟从「日盘 225 + 夜盘 120」改为
全天 1440。沿用 243 会把 60m 年化基数压成 24×243=5832（真实 8760），
年化收益/波动标定整体失真约 1.5 倍。

本模块只做一件事：给定 bars 与周期，返回该周期每年的 bar 数。
优先从 bar 时间戳实测（trading_day_of_bar_time 即自然日），数据不足时兜底。
"""

from __future__ import annotations

from typing import Any

from ..calendar_day import trading_day_of_bar_time

# 加密 7×24：一年 = 365 个自然日（trading_day_of_bar_time 已是日期部分）
TRADING_DAYS_PER_YEAR = 365

# 各分钟周期对应的分钟数（"1d" 不参与折算）
TF_MINUTES: dict[str, int] = {
    "1m": 1,
    "5m": 5,
    "15m": 15,
    "30m": 30,
    "60m": 60,
    "240m": 240,
}

# 兜底日均交易分钟：加密 7×24 全天
FALLBACK_SESSION_MINUTES = 1440

# 少于该天数不做实测，避免样本过短把 bar/天 算歪
MIN_DAYS_FOR_MEASURE = 3


def distinct_trading_days(bars: list[dict[str, Any]]) -> int:
    """bars 覆盖的天数（trading_day_of_bar_time 取日期部分，7×24 即自然日）"""
    days: set[str] = set()
    for bar in bars:
        day = trading_day_of_bar_time(str(bar.get("time") or ""))
        if day:
            days.add(day)
    return len(days)


def bars_per_day(bars: list[dict[str, Any]], timeframe: str) -> float:
    """该周期日均 bar 数：优先实测，样本不足按全天时段折算"""
    minutes = TF_MINUTES.get(timeframe)
    if minutes is None:
        return 1.0
    n_days = distinct_trading_days(bars)
    if n_days >= MIN_DAYS_FOR_MEASURE and bars:
        return len(bars) / n_days
    return FALLBACK_SESSION_MINUTES / minutes


def bars_per_year(bars: list[dict[str, Any]], timeframe: str) -> int:
    """该周期每年 bar 数 —— 直接作为 evaluate_factor 的 periods

    日线返回 365；分钟线返回 日均 bar 数 × 365。
    未知周期按日线兜底，绝不返回小于 365 的值（避免比日线还低的荒谬基数）。
    """
    if timeframe == "1d" or timeframe not in TF_MINUTES:
        return TRADING_DAYS_PER_YEAR
    per_year = int(round(bars_per_day(bars, timeframe) * TRADING_DAYS_PER_YEAR))
    return max(TRADING_DAYS_PER_YEAR, per_year)
