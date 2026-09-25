"""年化基数推导 —— 按周期实测每年 bar 数

背景：因子评估原先把年化基数硬编码为 243（国内**日线**交易日数），
分钟周期沿用该值会把年化收益、Sortino、Calmar 一起压平：

    1m ≈ 84000 bar/年，用 243 → 年化低估约 345 倍
    5m ≈ 16800 → 约 69 倍       15m ≈ 5600 → 约 23 倍
    30m ≈ 2800 → 约 12 倍       60m ≈ 1400 → 约 6 倍

composite 适应度里收益项（ann/sortino/calmar 合计权重 0.75）被压到接近 0，
而对称性/换手/一致性是 O(1) 量级不受影响，遗传搜索在短周期上
实际变成了「优化多空对称与低换手」，这是短周期挖掘年率偏低的主因。

本模块只做一件事：给定 bars 与周期，返回该周期每年的 bar 数。
优先从 bar 时间戳实测（自动适配有无夜盘的品种），数据不足时按典型时段兜底。
"""

from __future__ import annotations

from typing import Any

from trading_hours import trading_day_of_bar_time

# 国内期货一年约 243 个交易日
TRADING_DAYS_PER_YEAR = 243

# 各分钟周期对应的分钟数（"1d" 不参与折算）
TF_MINUTES: dict[str, int] = {
    "1m": 1,
    "5m": 5,
    "15m": 15,
    "30m": 30,
    "60m": 60,
}

# 兜底日均交易分钟：国内商品期货日盘 225 分钟 + 典型夜盘 120 分钟
FALLBACK_SESSION_MINUTES = 345

# 少于该天数不做实测，避免样本过短把 bar/天 算歪
MIN_DAYS_FOR_MEASURE = 3


def distinct_trading_days(bars: list[dict[str, Any]]) -> int:
    """bars 覆盖的期货交易日天数（夜盘归次一交易日）"""
    days: set[str] = set()
    for bar in bars:
        day = trading_day_of_bar_time(str(bar.get("time") or ""))
        if day:
            days.add(day)
    return len(days)


def bars_per_day(bars: list[dict[str, Any]], timeframe: str) -> float:
    """该周期日均 bar 数：优先实测，样本不足按典型交易时段折算"""
    minutes = TF_MINUTES.get(timeframe)
    if minutes is None:
        return 1.0
    n_days = distinct_trading_days(bars)
    if n_days >= MIN_DAYS_FOR_MEASURE and bars:
        return len(bars) / n_days
    return FALLBACK_SESSION_MINUTES / minutes


def bars_per_year(bars: list[dict[str, Any]], timeframe: str) -> int:
    """该周期每年 bar 数 —— 直接作为 evaluate_factor 的 periods

    日线返回 243；分钟线返回 日均 bar 数 × 243。
    未知周期按日线兜底，绝不返回小于 243 的值（避免比日线还低的荒谬基数）。
    """
    from ..market import is_crypto
    if is_crypto(bars):
        if timeframe == "1d":
            return 365
        minutes = TF_MINUTES.get(timeframe)
        if minutes is None:
            raise ValueError(f"Unsupported crypto timeframe: {timeframe}")
        return 365 * 1440 // minutes
    if timeframe == "1d" or timeframe not in TF_MINUTES:
        return TRADING_DAYS_PER_YEAR
    per_year = int(round(bars_per_day(bars, timeframe) * TRADING_DAYS_PER_YEAR))
    return max(TRADING_DAYS_PER_YEAR, per_year)
