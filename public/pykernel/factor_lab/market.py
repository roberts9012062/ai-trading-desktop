"""Local crypto research contract. Bar metadata survives ordinary list slicing.

Prices may be spot proxies for long/short research; this does not model spot
borrowing, perpetual funding or executable exchange fees.

crypto_local_v2(见 research_context.py)是显式新版本:市场标记升级为
V2_PROFILE,特征层据此切换前缀不变窗口与缺失掩码;旧 CRYPTO_PROFILE
标记的 bars 保持旧语义逐位不变。
"""
from __future__ import annotations

from datetime import datetime, timezone, timedelta

CRYPTO_PROFILE = "crypto_ohlcv_v1"
V2_PROFILE = "crypto_local_v2"
# 短线档案标记:特征/缺失/归一化语义与 v2 同族(见 research_context.is_v2_family)
SHORTLINE_PROFILE = "shortline_v1"
V2_FAMILY = (V2_PROFILE, SHORTLINE_PROFILE)
LEGACY_FEATURE_COUNT = 40


def prepare_bars(payload: dict, bars: list) -> list:
    if not payload.get("crypto_profile") and not payload.get("research_profile"):
        return bars
    from data.product_specs import is_crypto_symbol
    if not is_crypto_symbol(str(payload.get("symbol") or "")):
        raise ValueError("Crypto factor profile requires a USDT crypto symbol")
    profile = str(payload.get("research_profile") or "")
    marker = profile if profile in V2_FAMILY else CRYPTO_PROFILE
    if bars and bars[0].get("_factor_market") in (CRYPTO_PROFILE, *V2_FAMILY):
        # 已带标记:只在旧标记上升级到 v2 族(显式请求时不降级)
        if marker in V2_FAMILY:
            return [dict(b, _factor_market=marker) if b.get("_factor_market") != marker else b for b in bars]
        return bars
    return [dict(b, _factor_market=marker) for b in bars]


def is_crypto(bars: list) -> bool:
    return bool(bars and bars[0].get("_factor_market") in (CRYPTO_PROFILE, *V2_FAMILY))


def is_v2(bars: list) -> bool:
    """bars 是否处于 crypto_local_v2 语义族(v2 特征/缺失/切分路径;含 shortline_v1)"""
    return bool(bars and bars[0].get("_factor_market") in V2_FAMILY)


def utc_time(value: str) -> datetime | None:
    """Unzoned app bar timestamps are Beijing time; zoned ISO times keep their offset."""
    try:
        dt = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc if len(str(value)) == 10 else timezone(timedelta(hours=8)))
        return dt.astimezone(timezone.utc)
    except (TypeError, ValueError):
        return None
