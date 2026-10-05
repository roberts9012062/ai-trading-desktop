"""AI 任务资金仓与持仓周期约束

设计说明：
- 用户创建任务时指定 allocated_capital，从可用余额中预留（软预留+流水记账）。
- 下单仍走同一 paper 账户；仓位 sizing 以「任务资金仓剩余额度」为上限。
- 多任务预留之和不得超过可用余额。
"""

from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal
from typing import Any
from uuid import UUID

class HTTPException(Exception):
    """fastapi 桩:本地内核无 fastapi,保持 raise/catch 兼容"""

    def __init__(self, status_code: int = 0, detail: str = "") -> None:
        self.status_code = status_code
        self.detail = detail
        super().__init__(detail)



# 风险风格
RISK_STYLES = frozenset({"aggressive", "balanced", "conservative"})

# K 线周期 → 默认最大持仓天数（日历天）
# 1m 默认 3 天；5m 默认 7 天；15m/30m 默认 30 天；60m 默认 2 个月(60 天)；1d 默认 3 个月(90 天)
# 用户可在创建/编辑任务时自行修改，未填则取此默认值
TIMEFRAME_MAX_HOLD_DAYS: dict[str, int] = {
    "1m": 3,
    "5m": 7,
    "15m": 30,
    "30m": 30,
    "60m": 60,
    "240m": 90,
    "1d": 90,
}

RISK_STYLE_LABELS: dict[str, str] = {
    "aggressive": "激进",
    "balanced": "稳健",
    "conservative": "保守",
}

# 风格对仓位预算的倍率（相对 allocated 剩余）
RISK_STYLE_BUDGET_RATIO: dict[str, float] = {
    "aggressive": 1.0,
    "balanced": 0.7,
    "conservative": 0.4,
}

# 风格对模型 confidence 的最低要求（低于则强制 hold 开仓）
RISK_STYLE_MIN_CONFIDENCE: dict[str, float] = {
    "aggressive": 0.35,
    "balanced": 0.5,
    "conservative": 0.65,
}

# ---------------------------------------------------------------------------
# 风格全面画像：在用户给定规则范围内调节止盈/止损/持仓/节奏
# - 用户设定 = 基准区间
# - 激进：止盈可晚于用户目标（让利润多跑）、止损略宽、用满持仓上限
# - 稳健：严格按用户设定执行
# - 保守：更早止盈（约 1/3 用户目标）、更紧止损、更短持仓、快进快出
# ---------------------------------------------------------------------------
# take_profit_mult: 作用于用户 pnl_pct / total_pnl_pct（>1 更晚止盈，<1 更早）
# stop_loss_mult: 作用于用户 loss_pct / loss_amount 阈值宽度（>1 更宽，<1 更紧）
# hold_days_mult: 作用于周期 max_hold_days 上限
RISK_STYLE_PROFILES: dict[str, dict[str, Any]] = {
    "aggressive": {
        "budget_ratio": 1.0,
        "min_confidence": 0.35,
        "take_profit_mult": 1.5,
        "stop_loss_mult": 1.25,
        "hold_days_mult": 1.0,
        "label_cn": "激进",
        "pace": "快进、利润奔跑、止盈可晚于用户目标",
        "prompt_hint": (
            "激进风格：可用满资金仓；信号出现后果断开仓；"
            "止盈目标可高于用户设定（让利润多跑到约 1.5 倍用户目标再兑现）；"
            "止损可略宽于用户设定；在最长持仓上限内尽量持有优势仓；"
            "仍禁止赌气加仓，硬止损与持仓上限不可突破。"
        ),
    },
    "balanced": {
        "budget_ratio": 0.7,
        "min_confidence": 0.5,
        "take_profit_mult": 1.0,
        "stop_loss_mult": 1.0,
        "hold_days_mult": 1.0,
        "label_cn": "稳健",
        "pace": "中等节奏，严格按用户止盈止损与持仓上限",
        "prompt_hint": (
            "稳健风格：中等仓位；严格按用户设定的止盈/止损执行；"
            "持仓不超过周期上限；无优势则 hold；以完成盈利目标且控制回撤并重。"
        ),
    },
    "conservative": {
        "budget_ratio": 0.4,
        "min_confidence": 0.65,
        "take_profit_mult": 1.0 / 3.0,  # 约三分之一用户目标即止盈
        "stop_loss_mult": 0.5,  # 更紧止损
        "hold_days_mult": 0.5,  # 更短持仓
        "label_cn": "保守",
        "pace": "快进快出、见好就收、优先保护本金",
        "prompt_hint": (
            "保守风格：低仓位、高把握才开仓；快进快出；"
            "止盈约在用户目标的三分之一即兑现；止损约为用户设定的一半（更紧）；"
            "持仓时间约为周期上限的一半；优先少亏与锁定已有利润。"
        ),
    },
}


def get_style_profile(
    risk_style: str | None,
    custom_prompt_enabled: bool = False,
) -> dict[str, Any]:
    """取风格画像；未知则稳健

    启用用户提示词时：策略风格失效，返回「用户提示词主导」画像
    （止盈/止损/持仓不缩放，预算用满资金仓，无置信度门槛）。
    """
    if custom_prompt_enabled:
        return {
            "budget_ratio": 1.0,
            "min_confidence": 0.0,
            "take_profit_mult": 1.0,
            "stop_loss_mult": 1.0,
            "hold_days_mult": 1.0,
            "label_cn": "用户提示词",
            "pace": "策略风格已停用，按用户提示词执行",
            "prompt_hint": (
                "已启用用户提示词：激进/稳健/保守策略风格全部失效；"
                "仓位节奏、止盈止损意图、进出场均以用户提示词为执行准则；"
                "系统硬规则仅保留：用户填写的止盈/止损原值、周期最长持仓上限、"
                "多空模式、仓位模式与资金仓额度，不得突破。"
            ),
            "style_active": False,
            "driven_by": "custom_prompt",
        }
    style = (risk_style or "balanced").strip().lower()
    if style not in RISK_STYLE_PROFILES:
        style = "balanced"
    profile = dict(RISK_STYLE_PROFILES[style])
    profile["style_active"] = True
    profile["driven_by"] = "risk_style"
    return profile


def effective_max_hold_days(
    base_max_hold_days: int,
    risk_style: str | None,
    custom_prompt_enabled: bool = False,
) -> int:
    """风格缩放后的最长持仓天数（至少 1 天，不超过用户/周期上限）"""
    profile = get_style_profile(risk_style, custom_prompt_enabled)
    base = max(1, int(base_max_hold_days or 1))
    mult = float(profile.get("hold_days_mult") or 1.0)
    # 保守缩短；激进/稳健/用户提示词模式不超过 base
    scaled = int(max(1, round(base * mult)))
    return min(base, scaled) if mult <= 1.0 else base


def apply_style_to_trade_rules(
    *,
    risk_style: str | None,
    close_rules: dict[str, Any] | None,
    stop_rules: dict[str, Any] | None,
    max_hold_days: int,
    custom_prompt_enabled: bool = False,
) -> dict[str, Any]:
    """将用户规则按风格缩放为「生效规则」

    custom_prompt_enabled=True 时策略风格失效，生效规则 = 用户原值。

    返回:
      close_rules / stop_rules / max_hold_days / profile / style_active
    """
    profile = get_style_profile(risk_style, custom_prompt_enabled)
    user_close = dict(close_rules or {})
    user_stop = dict(stop_rules or {})
    tp_m = float(profile["take_profit_mult"])
    sl_m = float(profile["stop_loss_mult"])

    eff_close = dict(user_close)
    eff_stop = dict(user_stop)

    # 止盈：用户设定 × 风格倍率（激进变大=更晚触发；保守变小=更早触发）
    if user_close.get("pnl_pct") is not None:
        try:
            base = abs(float(user_close["pnl_pct"]))
            eff_close["pnl_pct"] = round(base * tp_m, 6)
            eff_close["_user_pnl_pct"] = base
        except (TypeError, ValueError):
            pass
    if user_close.get("total_pnl_pct") is not None:
        try:
            base = abs(float(user_close["total_pnl_pct"]))
            eff_close["total_pnl_pct"] = round(base * tp_m, 6)
            eff_close["_user_total_pnl_pct"] = base
        except (TypeError, ValueError):
            pass

    # 止损：用户阈值 × 风格倍率（激进更宽；保守更紧）
    if user_stop.get("loss_pct") is not None:
        try:
            base = abs(float(user_stop["loss_pct"]))
            eff_stop["loss_pct"] = round(base * sl_m, 6)
            eff_stop["_user_loss_pct"] = base
        except (TypeError, ValueError):
            pass
    if user_stop.get("loss_amount") is not None:
        try:
            base = abs(float(user_stop["loss_amount"]))
            eff_stop["loss_amount"] = round(base * sl_m, 6)
            eff_stop["_user_loss_amount"] = base
        except (TypeError, ValueError):
            pass

    eff_hold = effective_max_hold_days(
        int(max_hold_days or 1),
        risk_style,
        custom_prompt_enabled,
    )
    # 用户提示词模式：不写 _user_* 缩放对照（规则即用户原值）
    if custom_prompt_enabled:
        for key in (
            "_user_pnl_pct",
            "_user_total_pnl_pct",
            "_user_loss_pct",
            "_user_loss_amount",
        ):
            eff_close.pop(key, None)
            eff_stop.pop(key, None)
    return {
        "close_rules": eff_close,
        "stop_rules": eff_stop,
        "max_hold_days": eff_hold,
        "profile": profile,
        "user_max_hold_days": int(max_hold_days or 1),
        "style_active": bool(profile.get("style_active", True)),
        "custom_prompt_enabled": bool(custom_prompt_enabled),
    }


def max_hold_days_for_timeframe(timeframe: str) -> int:
    """按周期返回最大持仓天数"""
    tf = (timeframe or "").strip().lower()
    if tf not in TIMEFRAME_MAX_HOLD_DAYS:
        raise HTTPException(status_code=400, detail=f"不支持的周期: {timeframe}")
    return TIMEFRAME_MAX_HOLD_DAYS[tf]


def normalize_risk_style(value: str | None) -> str:
    """规范化风险风格，默认稳健"""
    style = (value or "balanced").strip().lower()
    if style in ("激进",):
        style = "aggressive"
    elif style in ("稳健",):
        style = "balanced"
    elif style in ("保守",):
        style = "conservative"
    if style not in RISK_STYLES:
        raise HTTPException(
            status_code=400,
            detail="risk_style 仅支持 aggressive/balanced/conservative（激进/稳健/保守）",
        )
    return style


def horizon_label(timeframe: str) -> str:
    """周期对应交易视野文案"""
    days = TIMEFRAME_MAX_HOLD_DAYS.get((timeframe or "").strip().lower(), 10)
    if days <= 2:
        return "超短线"
    if days <= 10:
        return "中线"
    return "长线"


async def sum_active_allocated(
    session: AsyncSession,
    user_id: UUID,
    trading_mode: str,
    exclude_task_id: UUID | None = None,
) -> Decimal:
    """统计未结束任务已预留资金之和"""
    stmt = select(AITradingTask).where(
        AITradingTask.user_id == user_id,
        AITradingTask.trading_mode == trading_mode,
        AITradingTask.status.in_(("running", "paused")),
    )
    result = await session.execute(stmt)
    total = Decimal("0")
    for task in result.scalars().all():
        if exclude_task_id is not None and task.id == exclude_task_id:
            continue
        total += Decimal(str(getattr(task, "allocated_capital", 0) or 0))
    return total


def _task_mode(task: AITradingTask) -> str:
    """取任务交易盘模式"""
    return str(getattr(task, "trading_mode", None) or "live")


async def reserve_task_capital(
    session: AsyncSession,
    task: AITradingTask,
    amount: Decimal,
) -> None:
    """主账户 → 任务资金仓：真实划转（per-task 独立子账本）

    account.balance -= amount；task.capital_balance = amount
    """
    if amount <= 0:
        raise HTTPException(status_code=400, detail="资金仓金额必须大于 0")
    if amount < Decimal("1000"):
        raise HTTPException(status_code=400, detail="资金仓至少 ¥1000")

    account = await ensure_paper_account(session, task.user_id, _task_mode(task))
    available = Decimal(str(account.balance or 0))
    if amount > available:
        raise HTTPException(
            status_code=400,
            detail=f"主账户可用资金不足：可用 ¥{available}，需要 ¥{amount}",
        )

    account.balance = (account.balance - amount).quantize(Decimal("0.01"))
    account.updated_at = datetime.now(timezone.utc)
    task.capital_balance = amount
    _append_ledger(
        session,
        account,
        "ai_transfer_out",
        -amount,
        f"主账户→任务资金仓 ¥{amount} · 任务「{task.name}」",
        "ai_task",
        task.id,
    )


async def close_task_trade(
    session: AsyncSession,
    task: AITradingTask,
    back: Decimal,
) -> None:
    """平仓：主账户 → 任务资金仓回收（释放保证金 + 盈亏 - 手续费）

    task.capital_balance += back；account.balance -= back
    apply_close 已把 back 加到 account.balance，此处转回资金仓。
    """
    back_amt = Decimal(str(back)).quantize(Decimal("0.01"))
    if back_amt <= 0:
        return
    account = await ensure_paper_account(session, task.user_id, _task_mode(task))
    capital = Decimal(str(task.capital_balance or 0))
    task.capital_balance = (capital + back_amt).quantize(Decimal("0.01"))
    account.balance = (account.balance - back_amt).quantize(Decimal("0.01"))
    account.updated_at = datetime.now(timezone.utc)


async def release_task_capital(
    session: AsyncSession,
    task: AITradingTask,
) -> None:
    """任务删除：资金仓余额全部退回主账户

    account.balance += task.capital_balance；task.capital_balance = 0
    """
    capital = Decimal(str(task.capital_balance or 0))
    if capital <= 0:
        return
    account = await ensure_paper_account(session, task.user_id, _task_mode(task))
    account.balance = (account.balance + capital).quantize(Decimal("0.01"))
    account.updated_at = datetime.now(timezone.utc)
    task.capital_balance = Decimal("0")
    _append_ledger(
        session,
        account,
        "ai_transfer_in",
        capital,
        f"任务资金仓→主账户 ¥{capital} · 任务「{task.name}」删除释放",
        "ai_task",
        task.id,
    )


async def fund_task_trade(
    session: AsyncSession,
    task: AITradingTask,
    need: Decimal,
) -> None:
    """开仓：任务资金仓 → 主账户拨付（供 apply_open 扣保证金+手续费）

    task.capital_balance -= need；account.balance += need
    不足则报「资金仓不足」。
    """
    need_amt = Decimal(str(need)).quantize(Decimal("0.01"))
    if need_amt <= 0:
        return
    account = await ensure_paper_account(session, task.user_id, _task_mode(task))
    capital = Decimal(str(task.capital_balance or 0))
    if capital < need_amt:
        raise HTTPException(
            status_code=400,
            detail=(
                f"任务资金仓不足：仓内 ¥{capital}，"
                f"本笔需要 ¥{need_amt}（{task.symbol}）"
            ),
        )
    task.capital_balance = (capital - need_amt).quantize(Decimal("0.01"))
    account.balance = (account.balance + need_amt).quantize(Decimal("0.01"))
    account.updated_at = datetime.now(timezone.utc)
    _append_ledger(
        session,
        account,
        "ai_fund_trade",
        need_amt,
        f"任务资金仓拨付交易金 ¥{need_amt} · {task.symbol} · 任务「{task.name}」",
        "ai_task",
        task.id,
    )


def ai_available_budget(
    *,
    allocated_capital: float,
    risk_style: str,
    account_available: float,
    position_margin: float,
    custom_prompt_enabled: bool = False,
    capital_usage_max_pct: float = 100.0,
    capital_usage_min_pct: float = 0.0,
) -> float:
    """计算本任务本次可用于开仓的保证金预算上限

    顺序：资金仓剩余 × 用户资金使用上限% × 风格预算比例，再与账户可用取 min。
    capital_usage_min_pct 不硬扣预算，仅供上下文提示 AI。
    启用用户提示词时风格比例=1。
    """
    _ = capital_usage_min_pct  # 预留给调用方写入 context
    profile = get_style_profile(risk_style, custom_prompt_enabled)
    style_ratio = float(profile.get("budget_ratio") or RISK_STYLE_BUDGET_RATIO.get(
        (risk_style or "balanced").strip().lower(), 0.7
    ))
    try:
        usage_max = float(capital_usage_max_pct)
    except (TypeError, ValueError):
        usage_max = 100.0
    usage_max = max(0.0, min(100.0, usage_max))
    remaining = max(0.0, float(allocated_capital) - max(0.0, float(position_margin)))
    by_usage = remaining * (usage_max / 100.0)
    styled = by_usage * style_ratio
    return max(0.0, min(float(account_available), styled))


def normalize_qty_range(
    qty_min: int | None,
    qty_max: int | None,
    fixed_qty: int | None,
) -> tuple[int, int]:
    """规范化手数范围；缺省时回退 fixed_qty"""
    base = max(1, int(fixed_qty or 1))
    lo = max(1, int(qty_min if qty_min is not None else base))
    hi = max(1, int(qty_max if qty_max is not None else base))
    if hi < lo:
        lo, hi = hi, lo
    return lo, hi


def normalize_capital_usage_pct(
    min_pct: float | None,
    max_pct: float | None,
) -> tuple[float, float]:
    """规范化资金使用比例 0-100，保证 min<=max"""
    try:
        lo = float(0 if min_pct is None else min_pct)
    except (TypeError, ValueError):
        lo = 0.0
    try:
        hi = float(100 if max_pct is None else max_pct)
    except (TypeError, ValueError):
        hi = 100.0
    lo = max(0.0, min(100.0, lo))
    hi = max(0.0, min(100.0, hi))
    if hi < lo:
        lo, hi = hi, lo
    return lo, hi


def hold_days_elapsed(
    position_opened_at: datetime | None,
    now: datetime | None = None,
) -> float | None:
    """持仓已持续天数（浮点）；无开仓时间返回 None"""
    if position_opened_at is None:
        return None
    current = now or datetime.now(timezone.utc)
    opened = position_opened_at
    if opened.tzinfo is None:
        opened = opened.replace(tzinfo=timezone.utc)
    if current.tzinfo is None:
        current = current.replace(tzinfo=timezone.utc)
    delta = current - opened
    return max(0.0, delta.total_seconds() / 86400.0)


def check_max_hold(
    *,
    position: dict[str, Any] | None,
    position_opened_at: datetime | None,
    max_hold_days: int,
    now: datetime | None = None,
) -> dict[str, Any] | None:
    """超最长持仓天数则强制平仓"""
    qty = int(
        (position or {}).get("available_quantity")
        or (position or {}).get("quantity")
        or 0
    )
    if not position or qty <= 0:
        return None
    days = hold_days_elapsed(position_opened_at, now)
    if days is None:
        return None
    limit = max(1, int(max_hold_days or 1))
    if days >= float(limit):
        return {
            "action": "close",
            "reason": f"持仓已 {days:.1f} 天，超过本周期上限 {limit} 天，强制平仓",
            "trigger_type": "max_hold",
            "quantity": qty,
        }
    return None
