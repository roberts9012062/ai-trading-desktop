"""AI 交易决策提示词与 JSON 解析

目标：
1. 强制 JSON 决策输出
2. 明确「多赚少亏、以完成盈利目标为第一优先级」
3. 按风险风格 / 交易视野 / 最长持仓 / 资金仓约束决策
4. 可选拼接用户自定义提示词
"""

from __future__ import annotations

import json
import re
from typing import Any

# 合法动作
_VALID_ACTIONS = frozenset({"hold", "open_long", "open_short", "close"})

# 风险风格中文
_STYLE_CN = {
    "aggressive": "激进",
    "balanced": "稳健",
    "conservative": "保守",
}

SYSTEM_PROMPT = """你是中国商品期货模拟盘的专业自动交易决策模块。你的唯一使命是：在严格风控下实现账户资金的可持续增长——多赚少亏，以完成盈利目标为第一优先级。

【核心目标（最高业务优先级）】
1. 首要目标：扩大权益，优先兑现确定性盈利；次要目标：控制回撤与单笔亏损。
2. 「多赚」：趋势清晰、盈亏比有利时果断开仓/持有；浮盈可用规则允许的方式保护利润。
3. 「少亏」：信号矛盾、波动无序、或接近最长持仓上限时，优先减仓/平仓/观望，禁止赌气加仓。
4. 每一笔决策都要自问：是否服务于「完成盈利目标」？若否，输出 hold 或 close。
5. 禁止为了交易而交易；无优势时必须 hold。

【输出格式 — 协议最高优先级，违反即失败】
1. 整条回复只能是一个 JSON 对象，从第一个字符 { 到最后一个字符 }。
2. 禁止输出：分析过程、中文说明、markdown、代码围栏、前后缀、示例文字。
3. 禁止在 JSON 外写任何字（包括「输出JSON」「如下」等）。

【JSON schema】
{"action":"hold|open_long|open_short|close","quantity":0,"reason":"不超过40字的中文","confidence":0.0}

【字段】
- action: 仅四选一
- quantity: 整数；hold/close 可填 0；开仓为建议手数（系统会按资金仓与仓位模式二次校验）
- reason: 简短中文，聚焦目标/风险/周期，不要换行
- confidence: 0~1；把握不足时降低 confidence 并倾向 hold

【硬约束（必须遵守）】
1. side_mode：long_only 禁止 open_short；short_only 禁止 open_long
2. 价格与持仓只能使用上下文数据，禁止编造
3. 资金仓 allocated_capital / ai_budget 是本任务可支配上限，仓位意图不得突破
4. max_hold_days：持仓接近或超过上限时优先 close，不得新开仓拖延
5. risk_style 与用户提示词互斥：
   - 未启用用户提示词时，risk_style 全面影响仓位、止盈止损、持仓与节奏（在用户设定范围内缩放）
     · aggressive：高仓位；止盈约用户×1.5；止损略宽；用满持仓上限
     · balanced：严格按用户止盈/止损/持仓
     · conservative：止盈约用户×1/3；止损更紧；持仓约上限一半；快进快出
   - 一旦启用用户提示词：策略风格全部失效，按用户提示词执行；硬规则用用户止盈止损原值
6. position_mode 与手数/资金范围：
   - quantity 必须落在 qty_min~qty_max；系统会强制夹到该范围
   - 保证金预算不超过 allocated_capital × capital_usage_max_pct%（再叠加风格预算）
   - capital_usage_min_pct 为建议下限：无特殊理由时不要长期远低于该使用比例
   - fixed_qty/scale_in：以手数范围开仓；half/full：按预算半仓/全仓后再夹手数范围
   - scale_in：同向浮盈可加仓（系统限层）；浮亏禁止加仓；反向须先 close
7. 用户自定义提示词若启用，在不违反本系统硬约束的前提下尽量遵循

【正确示例】
{"action":"hold","quantity":0,"reason":"趋势不明保护本金","confidence":0.55}
{"action":"open_long","quantity":1,"reason":"突破确认服务盈利目标","confidence":0.72}
{"action":"close","quantity":0,"reason":"接近持仓上限锁定利润","confidence":0.8}

【错误示例 — 禁止】
近期走势偏弱，建议hold。{"action":"hold"...}
"""


# 仅当任务真实携带因子信号时拼入 system prompt，避免无因子任务的模型受诱导
FACTOR_SIGNAL_SECTION = """
【可选因子信号 context.factor_signal】
- 形如 {position:[-1,1], text:公式}；position>0 偏多，<0 偏空，|position| 为信号强度
- 作为量化参考（重要依据）；须结合风控与硬约束综合决策，不得仅凭因子盲动
"""


# 仅当存在枢轴波段信号时拼入 system prompt，避免无信号任务的模型受诱导
SWING_SIGNAL_SECTION = """
【可选枢轴波段信号 context.swing_signal】
- 形如 {side:"long"|"short", price, freshness, provisional, pivot_price}
- side=long 为最新确认的波谷反转（偏多参考），short 为波峰反转（偏空参考）
- freshness 为该枢轴距最新 bar 的根数，provisional=true 表示尚未完全确认
- 作为量化参考（重要依据）；须结合风控与硬约束综合决策，不得仅凭波段信号盲动
"""


# 仅当用户勾选了量化策略参考时拼入 system prompt
QUANT_REF_SIGNALS_SECTION = """
【可选量化策略参考 context.quant_ref_signals（用户勾选，多策略列表）】
- 形如 [{kind:"swing_pivot", action, signal, reason, close, detail}, ...]
- 每个元素为一条规则量化策略信号：action 为 open_long/open_short/close/hold，
  reason 为策略文案（如「枢轴波谷反转做多」「MACD金叉开多」），detail 为关键指标值
- 各策略相互独立，方向一致时强化判断，分歧时提示震荡风险
- 作为量化参考（重要依据）；须结合风控与硬约束综合决策，不得仅凭策略信号盲动
"""


def build_system_prompt(
    *,
    risk_style: str,
    timeframe: str,
    max_hold_days: int,
    horizon: str,
    allocated_capital: float,
    custom_prompt_enabled: bool,
    custom_prompt: str | None,
    user_max_hold_days: int | None = None,
    style_hint: str | None = None,
    effective_close_rules: dict[str, Any] | None = None,
    effective_stop_rules: dict[str, Any] | None = None,
    user_close_rules: dict[str, Any] | None = None,
    user_stop_rules: dict[str, Any] | None = None,
    style_active: bool | None = None,
    has_factor_signal: bool,
    has_swing_signal: bool,
    has_quant_ref_signals: bool = False,
) -> str:
    """系统提示词 + 任务级约束摘要 + 风格/用户提示词执行准则"""
    from capital import get_style_profile

    style = (risk_style or "balanced").strip().lower()
    style_cn = _STYLE_CN.get(style, style)
    profile = get_style_profile(style, bool(custom_prompt_enabled))
    active = (
        bool(style_active)
        if style_active is not None
        else bool(profile.get("style_active", not custom_prompt_enabled))
    )
    hint = (style_hint or profile.get("prompt_hint") or "").strip()
    user_hold = (
        int(user_max_hold_days)
        if user_max_hold_days is not None
        else int(max_hold_days)
    )
    parts: list[str] = [SYSTEM_PROMPT]
    if has_factor_signal:
        parts.append(FACTOR_SIGNAL_SECTION)
    if has_swing_signal:
        parts.append(SWING_SIGNAL_SECTION)
    if has_quant_ref_signals:
        parts.append(QUANT_REF_SIGNALS_SECTION)
    parts.extend(
        [
            "",
            "【本任务运行参数】",
            f"- timeframe: {timeframe}（{horizon}）",
            (
                f"- max_hold_days 生效: {int(max_hold_days)} 天"
                f"（用户/周期上限 {user_hold} 天；超时系统强制平仓）"
            ),
            f"- allocated_capital: {float(allocated_capital):.2f} 元（AI 资金仓）",
            "- 决策必须以完成盈利目标为主，多赚少亏。",
        ]
    )
    if custom_prompt_enabled and (custom_prompt or "").strip():
        user_extra = (custom_prompt or "").strip()[:2000]
        parts.extend(
            [
                "",
                "【执行模式：用户提示词主导 — 策略风格已失效】",
                "- 激进/稳健/保守策略风格全部停用，不得再按其缩放止盈止损或仓位节奏。",
                "- 止盈/止损硬规则使用用户填写的原值；周期最长持仓上限仍生效。",
                "- 进出场、持仓偏好、加仓减仓节奏一律优先遵循下方用户提示词。",
                "- 仍不得突破：多空模式、仓位模式、资金仓额度、用户止盈止损原值、最长持仓。",
                "",
                "【用户交易提示词 — 最高业务执行准则】",
                user_extra,
            ]
        )
    else:
        parts.extend(
            [
                f"- risk_style: {style}（{style_cn}）· {profile.get('pace', '')}",
                "- 风格只在用户给定范围内调节止盈/止损/节奏/持仓。",
            ]
        )
        if hint:
            parts.extend(["", "【风格执行指引】", hint])
        if effective_close_rules is not None or user_close_rules is not None:
            parts.extend(
                [
                    "",
                    "【止盈止损对照】",
                    (
                        "- 用户 close_rules: "
                        f"{json.dumps(user_close_rules or {}, ensure_ascii=False, default=str)}"
                    ),
                    (
                        "- 风格生效 close_rules: "
                        f"{json.dumps(effective_close_rules or {}, ensure_ascii=False, default=str)}"
                    ),
                    (
                        "- 用户 stop_rules: "
                        f"{json.dumps(user_stop_rules or {}, ensure_ascii=False, default=str)}"
                    ),
                    (
                        "- 风格生效 stop_rules: "
                        f"{json.dumps(effective_stop_rules or {}, ensure_ascii=False, default=str)}"
                    ),
                    "- 硬平仓以生效规则为准；close 意图应贴近风格节奏。",
                ]
            )
    if not active and not (custom_prompt_enabled and (custom_prompt or "").strip()):
        # 防御：风格未激活又无用户提示词时仍给出中性说明
        parts.append("- 当前未应用策略风格缩放，按用户规则原值执行。")
    return "\n".join(parts)


def build_user_prompt(context: dict[str, Any]) -> str:
    """构造用户侧上下文；再次强调只输出 JSON 与盈利目标"""
    compact = _compact_context(context)
    return (
        "根据上下文决策。以多赚少亏、完成盈利目标为第一优先级。"
        "只输出一行合法 JSON，不要其它任何字符。\n"
        f"context={json.dumps(compact, ensure_ascii=False, default=str)}"
    )


def _compact_context(context: dict[str, Any]) -> dict[str, Any]:
    """缩小上下文体积，降低啰嗦输出概率"""
    out = dict(context)
    bars = out.get("recent_bars")
    if isinstance(bars, list) and len(bars) > 12:
        slim: list[dict[str, Any]] = []
        for b in bars[-12:]:
            if not isinstance(b, dict):
                continue
            slim.append(
                {
                    "t": b.get("time") or b.get("datetime"),
                    "o": b.get("open"),
                    "h": b.get("high"),
                    "l": b.get("low"),
                    "c": b.get("close"),
                    "v": b.get("volume"),
                }
            )
        out["recent_bars"] = slim
    closed = out.get("closed_bar")
    if isinstance(closed, dict):
        out["closed_bar"] = {
            "t": closed.get("time") or closed.get("datetime"),
            "o": closed.get("open"),
            "h": closed.get("high"),
            "l": closed.get("low"),
            "c": closed.get("close"),
            "v": closed.get("volume"),
        }
    return out


def parse_decision_text(text: str) -> dict[str, Any]:
    """从模型输出中解析决策 JSON；失败时尽量抢救，不把原文塞进 reason"""
    raw = (text or "").strip()
    if not raw:
        return _fail("模型无输出")

    raw = raw.replace("﻿", "").replace("​", "").strip()

    fence = re.search(r"```(?:json)?\s*([\s\S]*?)```", raw, re.IGNORECASE)
    if fence:
        raw = fence.group(1).strip()

    data = _try_load_dict(raw)
    if data is not None:
        return _normalize(data)

    # 从后往前找平衡 JSON 对象：决策 JSON 通常在末尾，
    # 思考类模型可能在前缀输出自然语言（含干扰性 { ）
    starts = [i for i, ch in enumerate(raw) if ch == "{"]
    for start in reversed(starts):
        end = raw.rfind("}", start)
        if end <= start:
            continue
        seg = raw[start : end + 1]
        data = _try_load_dict(seg)
        if data is not None:
            return _normalize(data)
        data = _try_load_dict(_repair_object(seg))
        if data is not None:
            return _normalize(data)

    # 抢救路径（宽松字段/关键词推断）不是严格 JSON：parse_ok 置 False，
    # 供前端标记「解析失败」（在 _normalize 之后覆盖，避免被重置为 True）
    data = _extract_loose_fields(raw)
    if data is not None:
        return {**_normalize(data), "parse_ok": False}

    data = _infer_from_text(raw)
    if data is not None:
        return {**_normalize(data), "parse_ok": False}

    return _fail("模型未返回合法JSON")


def _fail(reason: str) -> dict[str, Any]:
    return {
        "action": "hold",
        "quantity": 0,
        "reason": reason[:80],
        "confidence": 0,
        "parse_ok": False,
    }


def _try_load_dict(s: str) -> dict[str, Any] | None:
    try:
        data = json.loads(s)
    except (json.JSONDecodeError, TypeError):
        return None
    return data if isinstance(data, dict) else None


def _repair_object(s: str) -> str:
    """尝试修复残缺 JSON 对象字符串"""
    text = s.strip()
    if not text.startswith("{"):
        text = "{" + text
    if not text.endswith("}"):
        text = re.sub(r",\s*$", "", text)
        text = text + "}"
    if "'" in text and '"' not in text:
        text = text.replace("'", '"')
    return text


def _extract_loose_fields(raw: str) -> dict[str, Any] | None:
    """从杂糅文本中抓 action/quantity/reason/confidence"""
    action_m = re.search(
        r'["\']?action["\']?\s*[:=]\s*["\']?(hold|open_long|open_short|close)["\']?',
        raw,
        re.IGNORECASE,
    )
    if not action_m:
        return None
    action = action_m.group(1).lower()
    qty = 0
    qty_m = re.search(r'["\']?quantity["\']?\s*[:=]\s*(\d+)', raw, re.IGNORECASE)
    if qty_m:
        qty = int(qty_m.group(1))
    reason = ""
    reason_m = re.search(
        r'["\']?reason["\']?\s*[:=]\s*["\']([^"\']{1,80})["\']',
        raw,
        re.IGNORECASE,
    )
    if reason_m:
        reason = reason_m.group(1)
    conf = 0.0
    conf_m = re.search(
        r'["\']?confidence["\']?\s*[:=]\s*([0-9]*\.?[0-9]+)',
        raw,
        re.IGNORECASE,
    )
    if conf_m:
        try:
            conf = float(conf_m.group(1))
        except ValueError:
            conf = 0.0
    if not reason:
        reason = "从模型杂糅输出中提取"
    return {
        "action": action,
        "quantity": qty,
        "reason": reason,
        "confidence": conf,
    }


def _infer_from_text(raw: str) -> dict[str, Any] | None:
    """最后手段：关键词推断，reason 用压缩摘要而非全文"""
    lower = raw.lower()
    action = "hold"
    if re.search(r"open_long|开多|做多|买入开仓", raw, re.IGNORECASE):
        action = "open_long"
    elif re.search(r"open_short|开空|做空|卖出开仓", raw, re.IGNORECASE):
        action = "open_short"
    elif re.search(r"\bclose\b|平仓|离场", raw, re.IGNORECASE):
        action = "close"
    elif "hold" in lower or "观望" in raw or "持币" in raw:
        action = "hold"
    else:
        return None
    cleaned = re.sub(r'[{}\[\]"]', " ", raw)
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    reason = cleaned[:40] if cleaned else "文本推断"
    return {
        "action": action,
        "quantity": 0,
        "reason": reason,
        "confidence": 0.3,
    }


def _normalize(data: dict[str, Any]) -> dict[str, Any]:
    action = str(data.get("action") or "hold").strip().lower()
    if action not in _VALID_ACTIONS:
        aliases = {
            "buy": "open_long",
            "long": "open_long",
            "sell": "open_short",
            "short": "open_short",
            "flat": "close",
            "exit": "close",
            "wait": "hold",
            "none": "hold",
        }
        action = aliases.get(action, "hold")
    try:
        quantity = int(data.get("quantity") or 0)
    except (TypeError, ValueError):
        quantity = 0
    reason = str(data.get("reason") or "无说明").strip()
    reason = re.sub(r"\s+", " ", reason)
    reason = reason[:80]
    try:
        confidence = float(data.get("confidence") or 0)
    except (TypeError, ValueError):
        confidence = 0.0
    return {
        "action": action,
        "quantity": max(0, quantity),
        "reason": reason,
        "confidence": max(0.0, min(1.0, confidence)),
        "parse_ok": True,
    }
