"""交易时段判定 —— 北京时间，按品种节段校验

供 scheduler / kline 粗粒度采集，以及 paper 下单严格校验。
"""

from __future__ import annotations

from datetime import date, datetime, time, timedelta, timezone
from typing import Any

from data.product_specs import extract_product_code
from session_profiles import (
    Session,
    all_sessions,
    get_profile,
    get_profile_key,
)

# 北京时间（UTC+8）
_BJ_TZ = timezone(timedelta(hours=8))

# 夜盘分界（交易日归属）
_NIGHT_SESSION_CUTOFF = time(21, 0)

# 粗粒度「有市场在交易」时段（兼容旧 is_trading_hours，含跨午夜夜盘）
_COARSE_SESSIONS: list[Session] = [
    (time(9, 0), time(11, 30)),
    (time(13, 0), time(15, 15)),
    (time(21, 0), time(2, 30)),  # 跨午夜
]


def beijing_now() -> datetime:
    """当前北京时间（带时区）"""
    return datetime.now(_BJ_TZ)


def _in_session(t: time, start: time, end: time) -> bool:
    """判断时刻是否落在 [start, end]（含端点）；end < start 表示跨午夜"""
    if start <= end:
        return start <= t <= end
    # 跨午夜：21:00-02:30 → t>=21:00 或 t<=02:30
    return t >= start or t <= end


def _any_session_open(t: time, sessions: list[Session]) -> bool:
    for start, end in sessions:
        if _in_session(t, start, end):
            return True
    return False


def _is_weekend_closed(bj: datetime, sessions: list[Session]) -> bool:
    """周末是否应休市

    规则：
    - 周六：仅允许跨午夜夜盘延续（00:00 ~ 夜盘结束），日盘/周六晚休市
    - 周日：全天休市，直至 21:00 夜盘（若该品种有夜盘）
    - 周一~周五：不因周末关闭
    """
    weekday = bj.weekday()  # Mon=0 ... Sun=6
    t = bj.time()

    if weekday == 5:  # 周六
        # 若当前落在跨午夜夜盘（end < start 的 session 的 end 侧），仍可开
        for start, end in sessions:
            if start > end and t <= end:
                return False
        return True

    if weekday == 6:  # 周日
        # 周日 21:00 起若有夜盘则开
        for start, end in sessions:
            if start >= time(21, 0) and _in_session(t, start, end):
                return False
            # 跨午夜 session 在周日白天（凌晨）不应开（周六凌晨已覆盖）
        return True

    return False


def is_trading_hours() -> bool:
    """粗粒度：当前是否有主流市场处于交易时段（北京时间）

    供行情采集调度使用，不区分品种。
    """
    bj = beijing_now()
    if _is_weekend_closed(bj, _COARSE_SESSIONS):
        return False
    return _any_session_open(bj.time(), _COARSE_SESSIONS)


def is_symbol_trading(symbol: str, now: datetime | None = None) -> bool:
    """指定合约当前是否可交易"""
    status = get_session_status(symbol, now)
    return bool(status["is_open"])


def get_session_status(
    symbol: str,
    now: datetime | None = None,
) -> dict[str, Any]:
    """返回合约交易时段状态详情"""
    bj = (now or datetime.now(timezone.utc)).astimezone(_BJ_TZ)
    code = extract_product_code(symbol)
    profile_key = get_profile_key(code)
    profile = get_profile(code)
    sessions = all_sessions(profile)
    t = bj.time()

    session_desc = [
        {
            "start": s.strftime("%H:%M"),
            "end": e.strftime("%H:%M"),
            "cross_midnight": s > e,
        }
        for s, e in sessions
    ]

    if _is_weekend_closed(bj, sessions):
        return {
            "symbol": symbol.strip().lower(),
            "product_code": code,
            "profile": profile_key,
            "profile_label": profile.get("label", profile_key),
            "is_open": False,
            "reason": "周末休市",
            "now_bj": bj.strftime("%Y-%m-%d %H:%M:%S"),
            "weekday": bj.weekday(),
            "sessions": session_desc,
            "message": f"{code} 当前周末休市，仅交易日开盘时段可下单",
        }

    if _any_session_open(t, sessions):
        return {
            "symbol": symbol.strip().lower(),
            "product_code": code,
            "profile": profile_key,
            "profile_label": profile.get("label", profile_key),
            "is_open": True,
            "reason": "交易中",
            "now_bj": bj.strftime("%Y-%m-%d %H:%M:%S"),
            "weekday": bj.weekday(),
            "sessions": session_desc,
            "message": f"{code} 交易中",
        }

    return {
        "symbol": symbol.strip().lower(),
        "product_code": code,
        "profile": profile_key,
        "profile_label": profile.get("label", profile_key),
        "is_open": False,
        "reason": "非交易时段",
        "now_bj": bj.strftime("%Y-%m-%d %H:%M:%S"),
        "weekday": bj.weekday(),
        "sessions": session_desc,
        "message": _closed_message(code, sessions, t),
    }


def _closed_message(code: str, sessions: list[Session], t: time) -> str:
    """生成休市提示"""
    parts = []
    for start, end in sessions:
        if start > end:
            parts.append(f"{start.strftime('%H:%M')}-{end.strftime('%H:%M')}(跨夜)")
        else:
            parts.append(f"{start.strftime('%H:%M')}-{end.strftime('%H:%M')}")
    session_text = "、".join(parts) if parts else "无"
    return (
        f"{code} 当前非交易时段（{t.strftime('%H:%M')}），"
        f"可交易时段：{session_text}"
    )


def _skip_weekend(d: date) -> date:
    """交易日不含周六日：周六→周一，周日→周一"""
    # weekday: Mon=0 ... Sat=5 Sun=6
    if d.weekday() == 5:
        return d + timedelta(days=2)
    if d.weekday() == 6:
        return d + timedelta(days=1)
    return d


def get_trading_day(now: datetime) -> datetime:
    """返回当前时间所属的期货交易日（零点，北京时间）

    规则（国内商品/股指常见口径）：
    - 当日 00:00~20:59：归属「当日」自然日，再跳过周末
    - 当日 21:00~23:59：归属「下一自然日」，再跳过周末
      · 周五 21:00 起 → 下周一（不是周六）
      · 周日 21:00 起 → 周一
    - 周六/周日凌晨（贵金属等跨夜延续）→ 下周一
    - 周六日白天无交易，若被调用也归到下周一
    """
    bj_now = now.astimezone(_BJ_TZ)
    d = bj_now.date()
    if bj_now.time() >= _NIGHT_SESSION_CUTOFF:
        d = d + timedelta(days=1)
    d = _skip_weekend(d)
    return datetime(d.year, d.month, d.day, tzinfo=_BJ_TZ)


def trading_day_of_bar_time(bar_time: str) -> str:
    """K 线 bar 时间串 → 所属期货交易日（YYYY-MM-DD）

    bar 时间为北京时间字符串，日线是 "YYYY-MM-DD"，分钟线是
    "YYYY-MM-DD HH:MM:SS"（见 kline 生成逻辑）。
    日线标签本身已是交易日，直接取日期部分；
    分钟线需按夜盘规则归属（21:00 之后属次一交易日），复用 get_trading_day。
    无法解析时返回空串，由调用方决定兜底。
    """
    text = bar_time.strip()
    if len(text) < 10:
        return ""
    date_part = text[:10]
    if len(text) < 19:
        return date_part
    try:
        naive = datetime.strptime(text[:19], "%Y-%m-%d %H:%M:%S")
    except ValueError:
        return date_part
    return get_trading_day(naive.replace(tzinfo=_BJ_TZ)).strftime("%Y-%m-%d")


def is_near_day_close(within_minutes: int = 5) -> bool:
    """是否接近日盘收盘（北京时间 15:00 前 within_minutes 分钟内，且工作日）

    用于 session_close 平仓时机：在收盘前 within_minutes 分钟触发，
    此时市场仍开，下单不会被交易时段校验拒绝（国内期货日盘统一 15:00 收盘）。
    """
    bj = beijing_now()
    if bj.weekday() >= 5:  # 周六=5、周日=6 → 周末休市
        return False
    now_min = bj.hour * 60 + bj.minute
    day_close_min = 15 * 60  # 15:00
    return (day_close_min - within_minutes) <= now_min < day_close_min
