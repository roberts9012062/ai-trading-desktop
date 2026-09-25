"""Local crypto research contract. Bar metadata survives ordinary list slicing.

Prices may be spot proxies for long/short research; this does not model spot
borrowing, perpetual funding or executable exchange fees.
"""
from __future__ import annotations

from datetime import datetime, timezone, timedelta

CRYPTO_PROFILE = "crypto_ohlcv_v1"
LEGACY_FEATURE_COUNT = 40


def prepare_bars(payload: dict, bars: list) -> list:
    if not payload.get("crypto_profile") or not bars:
        return bars
    from data.product_specs import is_crypto_symbol
    if not is_crypto_symbol(str(payload.get("symbol") or "")):
        raise ValueError("Crypto factor profile requires a USDT crypto symbol")
    if is_crypto(bars):
        return bars
    return [dict(b, _factor_market=CRYPTO_PROFILE) for b in bars]


def is_crypto(bars: list) -> bool:
    return bool(bars and bars[0].get("_factor_market") == CRYPTO_PROFILE)


def utc_time(value: str) -> datetime | None:
    """Unzoned app bar timestamps are Beijing time; zoned ISO times keep their offset."""
    try:
        dt = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc if len(str(value)) == 10 else timezone(timedelta(hours=8)))
        return dt.astimezone(timezone.utc)
    except (TypeError, ValueError):
        return None
