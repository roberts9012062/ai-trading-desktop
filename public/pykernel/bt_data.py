"""回测 K 线加载与区间裁剪"""

from __future__ import annotations

import random
from datetime import date, datetime, timedelta
from typing import Any



# 各周期回测区间上限（自然天）。日线半年；分钟线按数据密度递减
TIMEFRAME_MAX_DAYS: dict[str, int] = {
    "1d": 1825,
    "60m": 90,
    "30m": 60,
    "15m": 30,
    "5m": 7,
    "1m": 3,
}
DEFAULT_MAX_DAYS = 30
WARMUP_BARS = 120

# 多段回测：段数范围。每段长度 = 该周期上限天数（TIMEFRAME_MAX_DAYS），
# 因此多段模式的最小区间 = 段数 × 周期上限（含首尾天）。
SEGMENT_MIN_COUNT = 2
SEGMENT_MAX_COUNT = 5


def max_days_for(timeframe: str) -> int:
    """周期 → 允许的最大回测自然天数"""
    return TIMEFRAME_MAX_DAYS.get(
        str(timeframe or "").strip().lower(), DEFAULT_MAX_DAYS
    )


def parse_date(value: str) -> date:
    """YYYY-MM-DD → date"""
    return date.fromisoformat(str(value).strip()[:10])


def validate_range(
    start: date,
    end: date,
    timeframe: str,
    segment_count: int | None = None,
) -> None:
    """校验回测区间。

    单段（segment_count=None）：按周期上限校验最大天数。
    多段（segment_count=N）：不设上限，只要求含首尾天数 ≥ N × 周期上限，
    保证 N 个互不重叠的标准段能放进所选区间。
    """
    if end < start:
        raise ValueError("结束日期不能早于开始日期")
    max_days = max_days_for(timeframe)
    if segment_count is None:
        if (end - start).days > max_days:
            raise ValueError(f"{timeframe} 周期回测区间最多 {max_days} 天")
        if (end - start).days < 0:
            raise ValueError("无效日期区间")
    else:
        if not SEGMENT_MIN_COUNT <= segment_count <= SEGMENT_MAX_COUNT:
            raise ValueError(f"多段回测段数须为 {SEGMENT_MIN_COUNT}~{SEGMENT_MAX_COUNT}")
        min_days = max_days * segment_count
        if (end - start).days + 1 < min_days:
            raise ValueError(
                f"{timeframe} 周期 {segment_count} 段回测区间至少 {min_days} 天"
                f"（每段 {max_days} 天）"
            )
    # 不允许未来过多
    today = datetime.now().date()
    if start > today:
        raise ValueError("开始日期不能晚于今天")


def pick_random_segments(
    start: date,
    end: date,
    segment_count: int,
    segment_days: int,
    rng: random.Random | None = None,
) -> list[tuple[date, date]]:
    """在 [start, end] 内随机抽取 segment_count 个互不重叠的等长段。

    每段长度固定为 segment_days（含首尾）。富余天数
    slack = 总天数 − 段数×段长 被随机分配到 段数+1 个空档
    （首段前 / 段间 / 末段后），得到随机的段落分布；slack=0 时恰好铺满。
    rng 可注入以便测试复现。
    """
    rng = rng or random.Random()
    total_days = (end - start).days + 1
    if total_days < segment_count * segment_days:
        raise ValueError("区间天数不足以容纳多段回测")
    slack = total_days - segment_count * segment_days
    # 随机把 slack 拆进 n+1 个空档：抽 n+1 个权重取整，余数按小数部分大者补齐
    weights = [rng.random() + 1e-9 for _ in range(segment_count + 1)]
    wsum = sum(weights)
    gaps = [int(slack * w / wsum) for w in weights]
    remainder = slack - sum(gaps)
    order = sorted(range(segment_count + 1), key=lambda i: slack * weights[i] / wsum - gaps[i], reverse=True)
    for i in range(remainder):
        gaps[order[i % (segment_count + 1)]] += 1

    segments: list[tuple[date, date]] = []
    cursor = start + timedelta(days=gaps[0])
    for i in range(segment_count):
        seg_start = cursor
        seg_end = seg_start + timedelta(days=segment_days - 1)
        segments.append((seg_start, seg_end))
        cursor = seg_end + timedelta(days=1 + gaps[i + 1])
    return segments


def _bar_date(bar: dict[str, Any]) -> date | None:
    t = str(bar.get("time") or "")
    if not t:
        return None
    try:
        return date.fromisoformat(t[:10])
    except ValueError:
        return None


async def load_backtest_bars(*args, **kwargs):
    raise RuntimeError("本地内核不加载远程数据:bars 由 run_backtest_local 注入")



def slice_signal_window(
    bars: list[dict[str, Any]],
    end_index: int,
    window: int = 120,
) -> list[dict[str, Any]]:
    """取 end_index（含）之前最多 window 根"""
    if end_index < 0:
        return []
    begin = max(0, end_index + 1 - window)
    return bars[begin : end_index + 1]


def is_in_trade_range(bar: dict[str, Any], start: date, end: date) -> bool:
    """bar 是否落在回测交易区间（可下单）"""
    d = _bar_date(bar)
    if d is None:
        return False
    return start <= d <= end


def export_chart_bars(
    bars: list[dict[str, Any]],
    start: date,
    end: date,
    max_bars: int,
) -> list[dict[str, Any]]:
    """导出前端 K 线（区间内 OHLC），过多时均匀降采样"""
    out: list[dict[str, Any]] = []
    for b in bars:
        if not is_in_trade_range(b, start, end):
            continue
        try:
            o = float(b.get("open") or 0)
            h = float(b.get("high") or 0)
            low = float(b.get("low") or 0)
            c = float(b.get("close") or 0)
        except (TypeError, ValueError):
            continue
        if o <= 0 or h <= 0 or low <= 0 or c <= 0:
            continue
        out.append(
            {
                "time": str(b.get("time") or ""),
                "open": o,
                "high": h,
                "low": low,
                "close": c,
                "volume": int(b.get("volume") or 0),
            }
        )
    if len(out) <= max_bars:
        return out
    step = max(1, len(out) // max_bars)
    sampled = out[::step]
    if sampled[-1] is not out[-1]:
        sampled.append(out[-1])
    return sampled


async def _no_data_hint(symbol: str, timeframe: str) -> str:
    """取数为空时的报错文案：能查到分钟历史边界就明确说出来

    tickdata 分钟数据深度受上游批次限制（当前约从 2025-10 起），
    更早的区间只有日线可回测 —— 把边界告诉用户，而不是让人猜
    "是不是没接入"。
    """
    base = "未获取到 K 线数据，请换品种/周期或稍后再试"
    if timeframe == "1d":
        return base
    try:
        from data.contracts import get_code_for_symbol
        from app.data.tickdata_kline import earliest_minute_date

        code = get_code_for_symbol(symbol)
        if not code:
            return base
        product = code.lower()
        earliest = await earliest_minute_date(product, timeframe)
        if not earliest:
            return base
        return (
            f"{timeframe} 分钟历史数据最早支持 {earliest}，所选区间早于此；"
            "更早的历史请改用日线回测"
        )
    except Exception:
        return base
