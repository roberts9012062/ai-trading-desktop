"""回测信号：复用量化策略 + 简化止盈止损"""

from __future__ import annotations

from typing import Any

def compute_quant_signal(strategy_type, bars, params, side_mode, position):
    if strategy_type != "factor":
        raise ValueError("此本机回测入口仅支持因子公式")
    from crypto_factor import compute_factor_signal
    return compute_factor_signal(bars, params, side_mode, position)


def quant_signal(
    strategy_type: str,
    bars: list[dict[str, Any]],
    params: dict[str, Any],
    side_mode: str,
    position: dict[str, Any] | None,
) -> dict[str, Any]:
    """量化信号（分发到 strategies 包）"""
    return compute_quant_signal(
        strategy_type, bars, params, side_mode, position
    )


def _pct(price: float, avg: float, side: str) -> float:
    """按方向计算盈亏百分比（多头价格涨为正，空头反之）"""
    if side == "long":
        return (price - avg) / avg * 100
    return (avg - price) / avg * 100


def apply_hard_rules(
    position: dict[str, Any] | None,
    last_price: float,
    stop_rules: dict[str, Any],
    close_rules: dict[str, Any],
    fixed_qty: int,
    *,
    max_hold_days: int | None = None,
    hold_days: float | None = None,
    risk_style: str | None = None,
    bar_high: float = 0.0,
    bar_low: float = 0.0,
    cash_delta_pct: float | None = None,
    session_closing: bool = False,
) -> dict[str, Any] | None:
    """止盈止损 + 最长持仓（与实时规则语义接近）

    stop/close 应为风格缩放后的生效规则；可含 _user_* 对照字段。

    逐 K 线判定时用盘中极值价（bar_high/bar_low）触发阈值：
    - 多头止损用 bar_low、止盈用 bar_high；
    - 空头止损用 bar_high、止盈用 bar_low。
    盘中触及即视为在该 bar 内触发，并以「精确止损/止盈价位」记账
    （trigger_price），避免用收盘价导致规则失真。
    极值价缺失或异常时回退到 last_price（收盘价）。
    """
    if not position or last_price <= 0:
        return None
    side = str(position.get("direction") or "")
    qty = float(position.get("quantity") or 0)
    avg = float(position.get("avg_price") or 0)
    if qty <= 0 or avg <= 0:
        return None
    style_tag = f"[{risk_style}]" if risk_style else ""

    # 盘中极值价防御：缺失或异常（不包住 last_price）时回退到收盘价
    hi = float(bar_high or 0)
    lo = float(bar_low or 0)
    if hi <= 0 or hi < last_price:
        hi = last_price
    if lo <= 0 or lo > last_price:
        lo = last_price

    # 最长持仓天数（优先级最高）
    if (
        max_hold_days is not None
        and hold_days is not None
        and hold_days >= float(max(1, int(max_hold_days)))
    ):
        return {
            "action": "close",
            "quantity": qty,
            "reason": (
                f"持仓已 {hold_days:.1f} 天{style_tag}，"
                f"超过上限 {int(max_hold_days)} 天"
            ),
        }

    # 按方向选取盘中止损/止盈探测价
    if side == "long":
        loss_probe = lo
        take_probe = hi
    else:
        loss_probe = hi
        take_probe = lo

    # —— 百分比止损 —— 用盘中探测价判断是否触及，以精确止损价成交
    loss_pct = stop_rules.get("loss_pct")
    if loss_pct is not None:
        loss_pct_f = abs(float(loss_pct))
        if _pct(loss_probe, avg, side) <= -loss_pct_f:
            user_ref = stop_rules.get("_user_loss_pct")
            extra = (
                f"（用户{abs(float(user_ref)):.2f}%→风格{loss_pct_f:.2f}%）"
                if user_ref is not None
                else ""
            )
            # 精确止损价：多头 avg*(1-L)，空头 avg*(1+L)
            trig = avg * (1 - loss_pct_f / 100) if side == "long" else avg * (1 + loss_pct_f / 100)
            return {
                "action": "close",
                "quantity": qty,
                "reason": f"止损{style_tag} 浮亏{_pct(loss_probe, avg, side):.2f}%@盘中{extra}",
                "trigger_price": trig,
            }

    # —— 金额止损 —— 与实盘 risk.py 对齐
    loss_amount = stop_rules.get("loss_amount")
    if loss_amount is not None:
        loss_amt_f = abs(float(loss_amount))
        # 用盘中探测价估算浮亏金额（avg/qty 粗算，不含乘数，与阈值同口径即可）
        probe_pnl_amt = (loss_probe - avg) * qty if side == "long" else (avg - loss_probe) * qty
        if probe_pnl_amt <= -loss_amt_f:
            user_ref = stop_rules.get("_user_loss_amount")
            extra = (
                f"（用户{abs(float(user_ref)):.2f}→风格{loss_amt_f:.2f}）"
                if user_ref is not None
                else ""
            )
            # 精确止损价：使浮亏金额恰好等于 -loss_amt_f
            if qty > 0:
                trig = avg - loss_amt_f / qty if side == "long" else avg + loss_amt_f / qty
            else:
                trig = loss_probe
            return {
                "action": "close",
                "quantity": qty,
                "reason": f"金额止损{style_tag} 浮亏{probe_pnl_amt:.2f}@盘中{extra}",
                "trigger_price": trig,
            }

    # —— 百分比止盈 —— 用盘中探测价判断是否触及，以精确止盈价成交
    take = close_rules.get("pnl_pct")
    if take is not None:
        take_f = abs(float(take))
        if _pct(take_probe, avg, side) >= take_f:
            user_ref = close_rules.get("_user_pnl_pct")
            extra = (
                f"（用户{abs(float(user_ref)):.2f}%→风格{take_f:.2f}%）"
                if user_ref is not None
                else ""
            )
            # 精确止盈价：多头 avg*(1+T)，空头 avg*(1-T)
            trig = avg * (1 + take_f / 100) if side == "long" else avg * (1 - take_f / 100)
            return {
                "action": "close",
                "quantity": qty,
                "reason": f"止盈{style_tag} 浮盈{_pct(take_probe, avg, side):.2f}%@盘中{extra}",
                "trigger_price": trig,
            }

    # —— 收盘平仓 —— 与实盘对齐（前端当前恒发 false，留作扩展）
    if close_rules.get("session_close") and session_closing:
        return {
            "action": "close",
            "quantity": qty,
            "reason": "收盘平仓规则触发",
            "trigger_price": last_price,
        }

    # —— 总收益止盈 —— 用收盘价与 baseline 比较（与实盘语义一致）
    total_target = close_rules.get("total_pnl_pct")
    if (
        total_target is not None
        and cash_delta_pct is not None
        and cash_delta_pct >= abs(float(total_target))
    ):
        user_ref = close_rules.get("_user_total_pnl_pct")
        extra = (
            f"（用户{abs(float(user_ref)):.2f}%→风格{abs(float(total_target)):.2f}%）"
            if user_ref is not None
            else ""
        )
        return {
            "action": "close",
            "quantity": qty,
            "reason": f"总收益止盈{style_tag} {cash_delta_pct:.2f}%{extra}",
            "trigger_price": last_price,
        }
    return None


def normalize_action(
    action: str,
    quantity: float,
    fixed_qty: float,
    side_mode: str,
    position: dict[str, Any] | None,
) -> tuple[str, float]:
    """规范动作与数量（基础币小数；fixed_qty 已是保证金×杠杆/价格口径）"""
    act = str(action or "hold").strip().lower()
    qty = float(quantity or 0)
    if qty <= 0:
        qty = float(fixed_qty or 0)
        if qty <= 0:
            return "hold", 0.0
    if side_mode == "long_only" and act == "open_short":
        return "hold", 0.0
    if side_mode == "short_only" and act == "open_long":
        return "hold", 0.0
    if act == "close" and not position:
        return "hold", 0.0
    if act in ("open_long", "open_short", "close"):
        return act, round(qty, 8)
    return "hold", 0.0
