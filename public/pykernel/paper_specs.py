"""品种规格解析 + 用户交易参数叠加"""

from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal
from typing import Any
from uuid import UUID


from data.contracts import get_decimal_places, get_tick_size
from data.product_specs import get_product_spec, list_all_product_specs


def _now_utc() -> datetime:
    return datetime.now(timezone.utc)


def _d(value: float | int | str | Decimal | None) -> Decimal | None:
    if value is None:
        return None
    return Decimal(str(value))


async def ensure_trade_settings(
    session: AsyncSession,
    user_id: UUID,
    trading_mode: str = "live",
) -> PaperTradeSettings:
    """获取或创建用户在指定盘下的交易参数（默认倍率 1.0）"""
    from app.core.trading_mode import normalize_trading_mode

    mode = normalize_trading_mode(trading_mode)
    stmt = select(PaperTradeSettings).where(
        PaperTradeSettings.user_id == user_id,
        PaperTradeSettings.trading_mode == mode,
    )
    result = await session.execute(stmt)
    row = result.scalar_one_or_none()
    if row is not None:
        return row
    row = PaperTradeSettings(
        user_id=user_id,
        trading_mode=mode,
        margin_scale=Decimal("1.0"),
        fee_scale=Decimal("1.0"),
        margin_rate_override=None,
        fee_mode_override=None,
        open_fee_override=None,
        close_fee_override=None,
        created_at=_now_utc(),
        updated_at=_now_utc(),
    )
    session.add(row)
    await session.flush()
    return row


def settings_to_dict(row: PaperTradeSettings) -> dict[str, Any]:
    """设置序列化"""
    return {
        "margin_scale": float(row.margin_scale),
        "fee_scale": float(row.fee_scale),
        "margin_rate_override": (
            float(row.margin_rate_override)
            if row.margin_rate_override is not None
            else None
        ),
        "fee_mode_override": row.fee_mode_override,
        "open_fee_override": (
            float(row.open_fee_override) if row.open_fee_override is not None else None
        ),
        "close_fee_override": (
            float(row.close_fee_override) if row.close_fee_override is not None else None
        ),
        "updated_at": row.updated_at.isoformat() if row.updated_at else None,
    }


async def update_trade_settings(
    session: AsyncSession,
    user_id: UUID,
    margin_scale: float | None,
    fee_scale: float | None,
    margin_rate_override: float | None,
    fee_mode_override: str | None,
    open_fee_override: float | None,
    close_fee_override: float | None,
    clear_overrides: bool,
    trading_mode: str = "live",
) -> dict[str, Any]:
    """更新用户交易参数"""
    row = await ensure_trade_settings(session, user_id, trading_mode)

    if margin_scale is not None:
        if margin_scale < 0.1 or margin_scale > 5:
            raise ValueError("保证金倍率须在 0.1~5")
        row.margin_scale = Decimal(str(margin_scale))

    if fee_scale is not None:
        if fee_scale < 0.0 or fee_scale > 10:
            raise ValueError("手续费倍率须在 0~10")
        row.fee_scale = Decimal(str(fee_scale))

    if clear_overrides:
        row.margin_rate_override = None
        row.fee_mode_override = None
        row.open_fee_override = None
        row.close_fee_override = None
    else:
        if margin_rate_override is not None:
            if margin_rate_override <= 0 or margin_rate_override > 1:
                raise ValueError("全局保证金率须在 (0,1]")
            row.margin_rate_override = Decimal(str(margin_rate_override))
        if fee_mode_override is not None:
            if fee_mode_override not in ("rate", "fixed", ""):
                raise ValueError("手续费模式须为 rate 或 fixed")
            row.fee_mode_override = fee_mode_override or None
        if open_fee_override is not None:
            row.open_fee_override = Decimal(str(open_fee_override))
        if close_fee_override is not None:
            row.close_fee_override = Decimal(str(close_fee_override))

    row.updated_at = _now_utc()
    await session.flush()
    return settings_to_dict(row)


def resolve_trade_params(
    symbol: str,
    settings: PaperTradeSettings | None,
) -> dict[str, Any]:
    """合并品种默认 + 用户设置 → 实际交易参数"""
    base = get_product_spec(symbol)
    mult = int(base["multiplier"])
    fee_mode = str(base["fee_mode"])
    open_fee = Decimal(str(base["open_fee"]))
    close_fee = Decimal(str(base["close_fee"]))
    margin_rate = Decimal(str(base["margin_rate"]))

    scale_m = Decimal("1.0")
    scale_f = Decimal("1.0")
    if settings is not None:
        scale_m = settings.margin_scale or Decimal("1.0")
        scale_f = settings.fee_scale or Decimal("1.0")
        if settings.margin_rate_override is not None:
            margin_rate = settings.margin_rate_override
        else:
            margin_rate = (margin_rate * scale_m).quantize(Decimal("0.0001"))
            # 上限保护
            if margin_rate > Decimal("1"):
                margin_rate = Decimal("1")
            if margin_rate < Decimal("0.001"):
                margin_rate = Decimal("0.001")

        if settings.fee_mode_override in ("rate", "fixed"):
            fee_mode = settings.fee_mode_override
            if settings.open_fee_override is not None:
                open_fee = settings.open_fee_override
            if settings.close_fee_override is not None:
                close_fee = settings.close_fee_override
        else:
            open_fee = (open_fee * scale_f).quantize(Decimal("0.00000001"))
            close_fee = (close_fee * scale_f).quantize(Decimal("0.00000001"))
    else:
        margin_rate = (margin_rate * scale_m).quantize(Decimal("0.0001"))

    return {
        "code": base["code"],
        "name": base.get("name", base["code"]),
        "multiplier": mult,
        "margin_rate": margin_rate,
        "fee_mode": fee_mode,
        "open_fee": open_fee,
        "close_fee": close_fee,
        "base_margin_rate": float(base["margin_rate"]),
        "base_open_fee": float(base["open_fee"]),
        "base_close_fee": float(base["close_fee"]),
        "base_fee_mode": str(base["fee_mode"]),
    }


def product_spec_public(symbol: str) -> dict[str, Any]:
    """对外返回品种默认规格（未叠加用户设置）"""
    base = get_product_spec(symbol)
    code = base["code"]
    return {
        "code": code,
        "name": base.get("name", base["code"]),
        "multiplier": int(base["multiplier"]),
        "margin_rate": float(base["margin_rate"]),
        "fee_mode": str(base["fee_mode"]),
        "open_fee": float(base["open_fee"]),
        "close_fee": float(base["close_fee"]),
        "description": _fee_desc(base),
        "tick_size": get_tick_size(code),
        "decimal_places": get_decimal_places(code),
    }


def _fee_desc(base: ProductSpec) -> str:
    mode = base["fee_mode"]
    if mode == "fixed":
        return f"定额 开{base['open_fee']}元/手 平{base['close_fee']}元/手"
    return (
        f"按金额 开{float(base['open_fee']) * 10000:.2f}/万 "
        f"平{float(base['close_fee']) * 10000:.2f}/万"
    )


def list_product_specs_public() -> list[dict[str, Any]]:
    """全部品种默认规格"""
    return [product_spec_public(item["code"]) for item in list_all_product_specs()]
