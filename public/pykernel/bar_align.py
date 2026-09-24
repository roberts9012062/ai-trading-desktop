"""K 线周期对齐 —— 计算 bar 边界与是否该触发评估"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

# 北京时间
_BJ_TZ = timezone(timedelta(hours=8))

# 周期分钟数（日线单独处理）
_PERIOD_MINUTES: dict[str, int] = {
    "1m": 1,
    "5m": 5,
    "15m": 15,
    "30m": 30,
    "60m": 60,
}

SUPPORTED_TIMEFRAMES: list[str] = ["1m", "5m", "15m", "30m", "60m", "1d"]


def beijing_now() -> datetime:
    """当前北京时间"""
    return datetime.now(_BJ_TZ)


def parse_bar_time(value: str | None) -> datetime | None:
    """解析 K 线 time 字段（常见 ISO / YYYY-MM-DD HH:MM:SS）"""
    if not value:
        return None
    text = str(value).strip().replace("T", " ").replace("Z", "")
    for fmt in (
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%d %H:%M",
        "%Y-%m-%d",
        "%Y/%m/%d %H:%M:%S",
    ):
        try:
            dt = datetime.strptime(text[:19] if len(text) >= 19 else text, fmt)
            return dt.replace(tzinfo=_BJ_TZ)
        except ValueError:
            continue
    return None


def floor_bar_start(now: datetime, timeframe: str) -> datetime:
    """将时间下取整到当前周期起点（北京时间）"""
    bj = now.astimezone(_BJ_TZ) if now.tzinfo else now.replace(tzinfo=_BJ_TZ)
    if timeframe == "1d":
        return bj.replace(hour=0, minute=0, second=0, microsecond=0)
    minutes = _PERIOD_MINUTES.get(timeframe)
    if minutes is None:
        raise ValueError(f"不支持的周期: {timeframe}")
    total = bj.hour * 60 + bj.minute
    floored = (total // minutes) * minutes
    return bj.replace(
        hour=floored // 60,
        minute=floored % 60,
        second=0,
        microsecond=0,
    )


def next_bar_boundary(now: datetime, timeframe: str) -> datetime:
    """下一根 K 线的理论起点"""
    start = floor_bar_start(now, timeframe)
    if timeframe == "1d":
        return start + timedelta(days=1)
    minutes = _PERIOD_MINUTES[timeframe]
    return start + timedelta(minutes=minutes)


def extract_closed_bar(
    bars: list[dict[str, Any]],
    last_bar_time: str | None,
) -> dict[str, Any] | None:
    """从历史 bars 中取最新一根「已收盘」bar（排除最后一根 forming）

    若 bars 仅 1 根，则仍返回它（便于调试）。
    若 time 与 last_bar_time 相同则返回 None（已处理过）。
    """
    if not bars:
        return None
    # 倒数第二根视为已收盘；只有一根时用最后一根
    candidate = bars[-2] if len(bars) >= 2 else bars[-1]
    bar_time = str(candidate.get("time") or candidate.get("datetime") or "")
    if not bar_time:
        return None
    if last_bar_time and bar_time == last_bar_time:
        return None
    return candidate


def should_run_for_bar(
    bars: list[dict[str, Any]],
    last_bar_time: str | None,
) -> tuple[bool, dict[str, Any] | None]:
    """是否应对新的已收盘 bar 运行"""
    closed = extract_closed_bar(bars, last_bar_time)
    if closed is None:
        return False, None
    return True, closed
