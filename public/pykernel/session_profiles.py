"""国内期货品种交易时段配置（北京时间）

按常见规则分组：日盘节段 + 夜盘收盘时刻。
周五夜盘可跨至周六凌晨；周六日盘、周日全天休市；周日 21:00 起夜盘开。
不含法定节假日（后续可接日历表）。
"""

from __future__ import annotations

from datetime import datetime, time, timedelta
from typing import Any

# 时段：start/end 为 time；若 end < start 表示跨午夜
Session = tuple[time, time]

# 日盘：商品（含 10:15-10:30 休市）
DAY_COMMODITY: list[Session] = [
    (time(9, 0), time(10, 15)),
    (time(10, 30), time(11, 30)),
    (time(13, 30), time(15, 0)),
]

# 日盘：股指
DAY_INDEX: list[Session] = [
    (time(9, 30), time(11, 30)),
    (time(13, 0), time(15, 0)),
]

# 日盘：国债
DAY_BOND: list[Session] = [
    (time(9, 30), time(11, 30)),
    (time(13, 0), time(15, 15)),
]

# 夜盘节段（单独，可与日盘叠加）
NIGHT_2300: list[Session] = [(time(21, 0), time(23, 0))]
NIGHT_0100: list[Session] = [(time(21, 0), time(1, 0))]  # 跨午夜
NIGHT_0230: list[Session] = [(time(21, 0), time(2, 30))]

# 配置项：day_sessions + night_sessions + label
Profile = dict[str, Any]

PROFILES: dict[str, Profile] = {
    "commodity_day": {
        "label": "商品日盘",
        "day": DAY_COMMODITY,
        "night": [],
    },
    "commodity_n2300": {
        "label": "商品+夜盘至23:00",
        "day": DAY_COMMODITY,
        "night": NIGHT_2300,
    },
    "commodity_n0100": {
        "label": "商品+夜盘至01:00",
        "day": DAY_COMMODITY,
        "night": NIGHT_0100,
    },
    "commodity_n0230": {
        "label": "商品+夜盘至02:30",
        "day": DAY_COMMODITY,
        "night": NIGHT_0230,
    },
    "index": {
        "label": "股指期货",
        "day": DAY_INDEX,
        "night": [],
    },
    "bond": {
        "label": "国债期货",
        "day": DAY_BOND,
        "night": [],
    },
}

# 品种代码 → profile key
# 夜盘收盘以国内主流交易所规则为准（北京时间）：
# - 02:30：贵金属/原油
# - 01:00：有色
# - 23:00：黑色、橡胶、能源化工、多数农产品
# - 无夜盘：股指/国债/部分农产品与新品种
PRODUCT_PROFILE: dict[str, str] = {
    # 夜盘 02:30 —— 贵金属、原油
    "AU": "commodity_n0230",
    "AG": "commodity_n0230",
    "SC": "commodity_n0230",
    # 夜盘 01:00 —— 有色
    "CU": "commodity_n0100",
    "AL": "commodity_n0100",
    "ZN": "commodity_n0100",
    "PB": "commodity_n0100",
    "NI": "commodity_n0100",
    "SN": "commodity_n0100",
    "SS": "commodity_n0100",
    "BC": "commodity_n0100",
    "AO": "commodity_n0100",
    # 夜盘 23:00 —— 黑色系（此前误配 02:30，会导致 23:00 后仍显示运行中）
    "RB": "commodity_n2300",
    "HC": "commodity_n2300",
    "WR": "commodity_n2300",
    "I": "commodity_n2300",
    "J": "commodity_n2300",
    "JM": "commodity_n2300",
    "SF": "commodity_n2300",
    "SM": "commodity_n2300",
    # 夜盘 23:00 —— 橡胶/纸浆/沥青/燃油
    "RU": "commodity_n2300",
    "NR": "commodity_n2300",
    "SP": "commodity_n2300",
    "BU": "commodity_n2300",
    "FU": "commodity_n2300",
    "LU": "commodity_n2300",
    # 夜盘 23:00 —— 农产品/化工等
    "M": "commodity_n2300",
    "Y": "commodity_n2300",
    "P": "commodity_n2300",
    "A": "commodity_n2300",
    "B": "commodity_n2300",
    "C": "commodity_n2300",
    "CS": "commodity_n2300",
    "RR": "commodity_n2300",
    "RM": "commodity_n2300",
    "OI": "commodity_n2300",
    "CF": "commodity_n2300",
    "CY": "commodity_n2300",
    "SR": "commodity_n2300",
    "TA": "commodity_n2300",
    "MA": "commodity_n2300",
    "FG": "commodity_n2300",
    "SA": "commodity_n2300",
    "PF": "commodity_n2300",
    "L": "commodity_n2300",
    "V": "commodity_n2300",
    "PP": "commodity_n2300",
    "EG": "commodity_n2300",
    "EB": "commodity_n2300",
    "PG": "commodity_n2300",
    "PX": "commodity_n2300",
    "SH": "commodity_n2300",
    "BR": "commodity_n2300",
    # 仅日盘
    "IF": "index",
    "IC": "index",
    "IM": "index",
    "IH": "index",
    "T": "bond",
    "TF": "bond",
    "TS": "bond",
    "TL": "bond",
    "AP": "commodity_day",
    "CJ": "commodity_day",
    "JD": "commodity_day",
    "LH": "commodity_day",
    "SI": "commodity_day",
    "LC": "commodity_day",
    "UR": "commodity_day",
    "WH": "commodity_day",
    "PM": "commodity_day",
    "RI": "commodity_day",
    "RS": "commodity_day",
    "FB": "commodity_day",
    "BB": "commodity_day",
    "EC": "commodity_day",
}

DEFAULT_PROFILE_KEY = "commodity_n2300"


def get_profile_key(product_code: str) -> str:
    """品种代码 → 时段配置 key"""
    return PRODUCT_PROFILE.get(product_code.upper(), DEFAULT_PROFILE_KEY)


def get_profile(product_code: str) -> Profile:
    """获取品种时段配置"""
    key = get_profile_key(product_code)
    return PROFILES[key]


def all_sessions(profile: Profile) -> list[Session]:
    """日盘 + 夜盘合并"""
    day: list[Session] = list(profile.get("day") or [])
    night: list[Session] = list(profile.get("night") or [])
    return day + night


def _active_session_block(
    profile: Profile,
    at: datetime,
) -> list[tuple[datetime, datetime]] | None:
    """返回 at 所属交易日的连续交易分钟轴（休盘间隔不计分钟）。

    有夜盘的品种从前一自然日夜盘连续到次日日盘。多数夜盘长度恰好可被
    30/60 整除，因此旧的“夜盘、日盘分别重置”问题被掩盖；02:30 收盘的
    品种夜盘共 330 分钟，其 60m 余下 30 分钟必须延续到日盘 09:30。
    """

    def on_start_date(session: Session, start_date) -> tuple[datetime, datetime]:
        start, end = session
        tz = at.tzinfo
        start_dt = datetime.combine(start_date, start, tzinfo=tz)
        end_date = start_date + timedelta(days=1) if end < start else start_date
        return start_dt, datetime.combine(end_date, end, tzinfo=tz)

    day_sessions: list[Session] = list(profile.get("day") or [])
    night_sessions: list[Session] = list(profile.get("night") or [])

    if night_sessions:
        first_night_start = min(start for start, _ in night_sessions)
        night_date = (
            at.date()
            if at.time() >= first_night_start
            else at.date() - timedelta(days=1)
        )
        day_date = night_date + timedelta(days=1)
        concrete = [
            *(on_start_date(session, night_date) for session in night_sessions),
            *(on_start_date(session, day_date) for session in day_sessions),
        ]
    else:
        concrete = [on_start_date(session, at.date()) for session in day_sessions]

    concrete.sort(key=lambda item: item[0])
    if concrete and concrete[0][0] <= at <= concrete[-1][1]:
        return concrete
    return None


def _axis_datetime(
    block: list[tuple[datetime, datetime]],
    position: int,
    *,
    prefer_next_at_break: bool = False,
) -> datetime:
    """把累计交易分钟位置映射回实际时钟。"""
    remaining = max(position, 0)
    for index, (start, end) in enumerate(block):
        duration = int((end - start).total_seconds() // 60)
        if remaining < duration:
            return start + timedelta(minutes=remaining)
        if remaining == duration:
            if prefer_next_at_break and index + 1 < len(block):
                return block[index + 1][0]
            return end
        remaining -= duration
    return block[-1][1]


def _elapsed_trading_minutes(
    block: list[tuple[datetime, datetime]],
    at: datetime,
) -> tuple[int, datetime | None, datetime | None]:
    """返回累计分钟、当前节段末端、最近已完成节段末端。"""
    elapsed = 0
    active_end: datetime | None = None
    previous_end: datetime | None = None
    for start, end in block:
        duration = int((end - start).total_seconds() // 60)
        if at < start:
            break
        if start <= at <= end:
            elapsed += int((at - start).total_seconds() // 60)
            active_end = end
            break
        elapsed += duration
        previous_end = end
    return elapsed, active_end, previous_end


def period_end_for_product(
    product_code: str,
    at: datetime,
    minutes: int,
) -> datetime | None:
    """按品种实际交易分钟轴计算当前多分钟 K 线的结束时刻。

    日盘的多个节段视为连续交易分钟轴，10:15-10:30 和午休不计分钟；
    夜盘与其后日盘共用交易分钟轴；末尾不足完整周期时钳制到闭市时刻。
    """
    if minutes <= 0:
        return None
    block = _active_session_block(get_profile(product_code), at)
    if not block:
        return None

    total_minutes = sum(
        int((end - start).total_seconds() // 60) for start, end in block
    )
    elapsed, active_end, previous_end = _elapsed_trading_minutes(block, at)

    if active_end is not None and at == active_end and elapsed % minutes == 0:
        return active_end
    if active_end is None and elapsed % minutes == 0:
        # 休盘前恰好封桶：短周期停留在上一根，不提前产生复市后的 forming 标签。
        return previous_end
    target = (elapsed // minutes + 1) * minutes
    target = min(target, total_minutes)
    return _axis_datetime(block, target)


def period_start_for_product(
    product_code: str,
    at: datetime,
    minutes: int,
) -> datetime | None:
    """返回 at 所属多分钟桶在交易分钟轴上的实际起点。"""
    if minutes <= 0:
        return None
    block = _active_session_block(get_profile(product_code), at)
    if not block:
        return None
    elapsed, _, _ = _elapsed_trading_minutes(block, at)
    start_position = (elapsed // minutes) * minutes
    return _axis_datetime(block, start_position, prefer_next_at_break=True)
