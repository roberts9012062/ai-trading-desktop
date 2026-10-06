def trading_day_of_bar_time(bar_time: str) -> str:
    """K 线 bar 时间串 → 所属交易日（YYYY-MM-DD）—— 即日期部分"""
    text = str(bar_time or '').strip()
    return text[:10] if len(text) >= 10 else ''
