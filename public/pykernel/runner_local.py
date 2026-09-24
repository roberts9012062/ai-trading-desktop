"""回测主循环 —— 量化全 bar；AI 限次调用模型"""

from __future__ import annotations

import logging
from datetime import date
from typing import Any


from account import VirtualAccount
from bt_data import (
    export_chart_bars,
    is_in_trade_range,
    max_days_for,
    parse_date,
    pick_random_segments,
    slice_signal_window,
    validate_range,
)
from metrics import (
    compute_metrics,
    downsample_equity,
    multi_segment_message,
    multi_segment_summary,
    summary_message,
)
from signals import (
    apply_hard_rules,
    normalize_action,
    quant_signal,
)
from strategies.quant_ref import build_quant_ref_signals
from paper_specs import resolve_trade_params

logger = logging.getLogger("qihuo.backtest")

# AI 回测最多调用模型次数（控制成本/耗时；经前端代理建议整段 <5 分钟）
AI_MAX_CALLS = 24
DEFAULT_CASH = 1_000_000.0


_BARS: list[dict[str, Any]] = []


def run_backtest_local(
    payload: dict[str, Any],
    bars: list[dict[str, Any]],
) -> dict[str, Any]:
    """本地(Pyodide)回测入口:K线由调用方注入,仅支持量化策略(无 AI/配额/落库)。"""
    if str(payload.get("strategy_type") or "").strip().lower() == "ai":
        raise ValueError("本地引擎暂不支持 AI 回测,请切换服务端模式")
    _BARS.clear()
    _BARS.extend(bars)
    """执行一次回测并返回报告。

    multi_segment=True 时：在 [start_date, end_date] 内随机抽取 segment_count
    个互不重叠的标准段（每段 = 周期上限天数），逐段独立回测（独立资金、
    独立开平仓、每段结束强制平仓）后聚合成汇总报告。
    """
    symbol = str(payload.get("symbol") or "").strip().lower()
    if not symbol:
        raise ValueError("请选择品种")
    timeframe = str(payload.get("timeframe") or "1d").strip()
    if timeframe not in ("1m", "5m", "15m", "30m", "60m", "1d"):
        raise ValueError("不支持的 K 线周期")

    start = parse_date(str(payload.get("start_date") or ""))
    end = parse_date(str(payload.get("end_date") or ""))
    multi_segment = bool(payload.get("multi_segment")) and timeframe != "1d"
    segment_count = int(payload.get("segment_count") or 2)
    validate_range(
        start, end, timeframe, segment_count=segment_count if multi_segment else None
    )

    strategy_type = str(payload.get("strategy_type") or "n_breakout").strip().lower()
    strategy_params = dict(payload.get("strategy_params") or {})
    # AI 回测可选多选量化策略参考（前端 AI 模式勾选，透传至 _ai_signal context）
    ref_strategies = payload.get("ref_strategies") or []
    side_mode = str(payload.get("side_mode") or "both")
    fixed_qty = int(payload.get("fixed_qty") or 1)
    initial_cash = float(payload.get("initial_cash") or DEFAULT_CASH)
    if initial_cash < 10000:
        initial_cash = 10000.0

    close_rules = dict(payload.get("close_rules") or {})
    stop_rules = dict(payload.get("stop_rules") or {})
    model_row_id = payload.get("model_row_id")
    symbol_name = str(payload.get("symbol_name") or symbol)

    from capital import (
        TIMEFRAME_MAX_HOLD_DAYS,
        apply_style_to_trade_rules,
        normalize_risk_style,
    )

    try:
        risk_style = normalize_risk_style(str(payload.get("risk_style") or "balanced"))
    except Exception:
        risk_style = "balanced"
    base_max_hold_days = int(TIMEFRAME_MAX_HOLD_DAYS.get(timeframe, 10))
    custom_prompt_enabled = bool(payload.get("custom_prompt_enabled") or False)
    custom_prompt = payload.get("custom_prompt")
    if custom_prompt is not None:
        custom_prompt = str(custom_prompt).strip()[:2000] or None
    if strategy_type != "ai":
        custom_prompt_enabled = False
        custom_prompt = None
        # 量化：风格不缩放用户规则
        styled_rules = {
            "close_rules": dict(close_rules),
            "stop_rules": dict(stop_rules),
            "max_hold_days": base_max_hold_days,
            "user_max_hold_days": base_max_hold_days,
            "profile": {},
            "style_active": False,
        }
        risk_style = "balanced"
    else:
        # 启用用户提示词时策略风格失效，规则按用户原值
        styled_rules = apply_style_to_trade_rules(
            risk_style=risk_style,
            close_rules=close_rules,
            stop_rules=stop_rules,
            max_hold_days=base_max_hold_days,
            custom_prompt_enabled=custom_prompt_enabled,
        )
    # 回测硬规则使用生效值（风格缩放或用户原值）
    user_close_baseline = dict(payload.get("close_rules") or {})
    user_stop_baseline = dict(payload.get("stop_rules") or {})
    close_rules = dict(styled_rules["close_rules"])
    stop_rules = dict(styled_rules["stop_rules"])
    max_hold_days = int(styled_rules["max_hold_days"])
    user_max_hold_days = int(
        styled_rules.get("user_max_hold_days") or base_max_hold_days
    )
    style_active = bool(styled_rules.get("style_active", not custom_prompt_enabled))

    if strategy_type == "ai" and not model_row_id:
        raise ValueError("AI 回测请选择模型")

    params = resolve_trade_params(symbol, None)

    def _run_range(
        seg_start: date, seg_end: date, ai_call_budget: int
    ) -> dict[str, Any]:
        """在 [seg_start, seg_end] 上独立执行一段回测（含结束平仓与指标）"""
        bars = [
            b for b in _BARS
            if seg_start.isoformat() <= str(b.get("time", ""))[:10] <= seg_end.isoformat()
        ]

        account = VirtualAccount(
            cash=initial_cash,
            multiplier=int(params["multiplier"]),
            margin_rate=float(params["margin_rate"]),
            fee_mode=str(params["fee_mode"]),
            open_fee=float(params["open_fee"]),
            close_fee=float(params["close_fee"]),
        )

        equity_curve: list[dict[str, Any]] = []
        decisions: list[dict[str, Any]] = []
        ai_calls = 0
        # AI 接口连续失败计数：接口故障/限流时中止回测，避免烧完预算产出废结果
        ai_iface_fails = 0
        # 记录开仓 bar 时间，用于最长持仓
        position_open_time: str | None = None
        trade_bar_indices = [
            i for i, b in enumerate(bars) if is_in_trade_range(b, seg_start, seg_end)
        ]
        # AI：均匀抽样 bar 索引
        ai_sample: set[int] = set()
        if strategy_type == "ai" and trade_bar_indices:
            step = max(1, len(trade_bar_indices) // ai_call_budget)
            ai_sample = set(trade_bar_indices[::step][:ai_call_budget])
            if trade_bar_indices[-1] not in ai_sample:
                ai_sample.add(trade_bar_indices[-1])

        for i, bar in enumerate(bars):
            price = float(bar.get("close") or 0)
            bar_time = str(bar.get("time") or "")
            if price <= 0:
                continue

            in_range = is_in_trade_range(bar, seg_start, seg_end)
            if not in_range:
                continue

            pos = account.position_dict()
            hold_days = _hold_days(position_open_time, bar_time) if pos else None
            # 1) 硬规则（含最长持仓、盘中 high/low 触发止损止盈）
            hard = apply_hard_rules(
                pos,
                price,
                stop_rules,
                close_rules,
                fixed_qty,
                max_hold_days=max_hold_days,
                hold_days=hold_days,
                risk_style=(
                    (risk_style if style_active else "custom_prompt")
                    if strategy_type == "ai"
                    else None
                ),
                bar_high=float(bar.get("high") or 0),
                bar_low=float(bar.get("low") or 0),
            )
            if hard:
                act, qty = hard["action"], int(hard["quantity"])
                reason = hard["reason"]
                # 盘中触发时用精确止损/止盈价记账，更贴近限价止损单
                exec_price = float(hard.get("trigger_price") or price)
                if exec_price <= 0:
                    exec_price = price
                account.apply(act, qty, exec_price, bar_time, reason)
                if act == "close":
                    position_open_time = None
                decisions.append(
                    {
                        "time": bar_time,
                        "action": act,
                        "quantity": qty,
                        "price": exec_price,
                        "reason": reason,
                        "source": "rule",
                    }
                )
            else:
                # 2) 策略信号
                signal_bars = slice_signal_window(bars, i, 120)
                if strategy_type == "ai":
                    if i not in ai_sample:
                        sig = {"action": "hold", "quantity": 0, "reason": "AI抽样跳过"}
                        source = "ai_skip"
                    else:
                        ai_calls += 1
                        sig = _ai_signal(
                            session,
                            user_id,
                            str(model_row_id),
                            {
                                "symbol": symbol,
                                "symbol_name": symbol_name,
                                "timeframe": timeframe,
                                "side_mode": side_mode,
                                "position_mode": "fixed_qty",
                                "fixed_qty": fixed_qty,
                                "risk_style": risk_style,
                                "style_active": style_active,
                                "custom_prompt_enabled": custom_prompt_enabled,
                                "style_hint": (styled_rules.get("profile") or {}).get(
                                    "prompt_hint"
                                ),
                                "user_max_hold_days": user_max_hold_days,
                                "max_hold_days": max_hold_days,
                                "hold_days": hold_days,
                                "allocated_capital": initial_cash,
                                "ai_budget": account.cash,
                                "last_price": price,
                                "position": pos,
                                "account": {
                                    "total_equity": account.equity(price),
                                    "available_margin": account.cash,
                                },
                                "user_close_rules": user_close_baseline,
                                "user_stop_rules": user_stop_baseline,
                                "close_rules": {
                                    k: v
                                    for k, v in close_rules.items()
                                    if not str(k).startswith("_")
                                },
                                "stop_rules": {
                                    k: v
                                    for k, v in stop_rules.items()
                                    if not str(k).startswith("_")
                                },
                                "recent_bars": signal_bars[-30:],
                                "closed_bar": bar,
                                # 用户多选量化策略参考 → 注入参考信号；未多选时保留固定枢轴参考（旧行为）
                                "quant_ref_signals": (
                                    build_quant_ref_signals(ref_strategies, signal_bars)
                                    if ref_strategies
                                    else None
                                ),
                                "swing_signal": (
                                    None
                                    if ref_strategies
                                    else _swing_signal_for_ai(signal_bars)
                                ),
                                "goal": (
                                    "多赚少亏，以完成盈利目标为第一优先级；"
                                    + (
                                        "已启用用户提示词，策略风格失效"
                                        if custom_prompt_enabled
                                        else "风格在用户规则范围内调节"
                                    )
                                ),
                            },
                            risk_style=risk_style,
                            max_hold_days=max_hold_days,
                            allocated_capital=initial_cash,
                            custom_prompt_enabled=custom_prompt_enabled,
                            custom_prompt=custom_prompt,
                        )
                        source = "ai"
                        # 接口连续失败（异常/HTTP错误/空输出/熔断）累计中止，
                        # 成功一次即清零；中止以 ValueError 抛给 API 层转 400 提示
                        if str(sig.get("reason") or "").startswith(
                            (
                                "模型异常",
                                "模型HTTP",
                                "ClaudeHTTP",
                                "模型输出为空",
                                "模型接口熔断",
                            )
                        ):
                            ai_iface_fails += 1
                            if ai_iface_fails >= 6:
                                raise ValueError(
                                    f"模型接口连续失败 {ai_iface_fails} 次，"
                                    "回测已中止，请检查模型服务后重试"
                                )
                        else:
                            ai_iface_fails = 0
                else:
                    sig = quant_signal(
                        strategy_type,
                        signal_bars,
                        strategy_params,
                        side_mode,
                        pos,
                    )
                    source = strategy_type

                act, qty = normalize_action(
                    str(sig.get("action") or "hold"),
                    int(sig.get("quantity") or 0),
                    fixed_qty,
                    side_mode,
                    account.position_dict(),
                )
                reason = str(sig.get("reason") or "")
                if act != "hold":
                    trade = account.apply(act, qty, price, bar_time, reason)
                    if trade:
                        if act in ("open_long", "open_short") and position_open_time is None:
                            position_open_time = bar_time
                        if act == "close":
                            position_open_time = None
                        decisions.append(
                            {
                                "time": bar_time,
                                "action": act,
                                "quantity": qty,
                                "price": price,
                                "reason": reason[:200],
                                "source": source,
                            }
                        )

            eq = account.equity(price)
            equity_curve.append(
                {
                    "time": bar_time,
                    "equity": round(eq, 2),
                    "cash": round(account.cash, 2),
                    "unrealized": round(account.unrealized(price), 2),
                }
            )

        # 结束强制平仓
        if bars:
            last = bars[-1]
            lp = float(last.get("close") or 0)
            lt = str(last.get("time") or "")
            if account.qty > 0 and lp > 0:
                account.apply("close", account.qty, lp, lt, "回测结束平仓")
                equity_curve.append(
                    {
                        "time": lt,
                        "equity": round(account.equity(lp), 2),
                        "cash": round(account.cash, 2),
                        "unrealized": 0.0,
                    }
                )

        final_price = float(bars[-1].get("close") or 0) if bars else 0
        final_eq = account.equity(final_price)
        metrics = compute_metrics(
            equity_curve,
            account.trades,
            initial_cash,
            final_eq,
            account.realized_pnl,
            account.fees_paid,
        )

        # 图表用 K 线：仅交易区间内，控制体积（最多 1500 根）
        chart_bars = export_chart_bars(bars, seg_start, seg_end, 1500)

        return {
            "metrics": metrics,
            "equity_curve": equity_curve,
            "bars": chart_bars,
            "trades": account.trades,
            "decisions": decisions,
            "ai_calls": ai_calls,
            "bar_count": len(bars),
            "trade_bars": len(trade_bar_indices),
        }

    def _base_config() -> dict[str, Any]:
        return {
            "symbol": symbol,
            "symbol_name": symbol_name,
            "timeframe": timeframe,
            "start_date": start.isoformat(),
            "end_date": end.isoformat(),
            "strategy_type": strategy_type,
            "strategy_params": strategy_params,
            "side_mode": side_mode,
            "fixed_qty": fixed_qty,
            "initial_cash": initial_cash,
            "risk_style": risk_style,
            "style_active": style_active,
            "max_hold_days": max_hold_days,
            "user_max_hold_days": user_max_hold_days,
            "custom_prompt_enabled": custom_prompt_enabled,
            "model_row_id": str(model_row_id) if model_row_id else None,
            "multi_segment": multi_segment,
        }

    if not multi_segment:
        r = _run_range(start, end, AI_MAX_CALLS)
        return {
            "status": "completed",
            "config": {
                **_base_config(),
                "ai_calls": r["ai_calls"],
                "bar_count": r["bar_count"],
                "trade_bars": r["trade_bars"],
            },
            "metrics": r["metrics"],
            "equity_curve": downsample_equity(r["equity_curve"], 400),
            "bars": r["bars"],
            "trades": r["trades"][-200:],
            "decisions": r["decisions"][-200:],
            "message": summary_message(r["metrics"], strategy_type, r["ai_calls"]),
        }

    # ---- 多段：随机抽段 → 逐段独立回测 → 聚合 ----
    seg_days = max_days_for(timeframe)
    # 段区间收紧到实际 K 线覆盖范围:请求区间常大于数据窗口(分钟线只存
    # 近期),按请求区间随机分段会把段铺进无数据区,产出"完成但全 0/无
    # K 线"的空报告。数据不足以容纳段数时明确报错,而非静默空跑。
    seg_start_date, seg_end_date = start, end
    if bars:
        data_start = parse_date(str(bars[0].get("time") or "")[:10])
        data_end = parse_date(str(bars[-1].get("time") or "")[:10])
        eff_start = max(start, data_start)
        eff_end = min(end, data_end)
        if eff_start <= eff_end:
            seg_start_date, seg_end_date = eff_start, eff_end
        covered = (seg_end_date - seg_start_date).days + 1
        if covered < segment_count * seg_days:
            max_segs = covered // seg_days
            raise ValueError(
                f"区间内实际 K 线仅覆盖 {seg_start_date.isoformat()}~{seg_end_date.isoformat()}"
                f"（{timeframe}，{covered} 天），不足以容纳 {segment_count} 段（每段 {seg_days} 天）；"
                f"当前数据最多可容纳 {max_segs} 段，请减少段数或改用数据更全的周期/区间"
            )
    segments = pick_random_segments(seg_start_date, seg_end_date, segment_count, seg_days)
    # AI 调用总预算保持 AI_MAX_CALLS 次并按段均分（下限 3），控制耗时与成本
    per_seg_ai_budget = (
        max(3, AI_MAX_CALLS // segment_count) if strategy_type == "ai" else AI_MAX_CALLS
    )

    segment_reports: list[dict[str, Any]] = []
    all_trades: list[dict[str, Any]] = []
    all_decisions: list[dict[str, Any]] = []
    stitched_curve: list[dict[str, Any]] = []
    total_ai_calls = 0
    total_bar_count = 0
    total_trade_bars = 0
    total_realized = 0.0
    total_fees = 0.0
    compound_factor = 1.0

    for idx, (seg_start, seg_end) in enumerate(segments):
        r = _run_range(seg_start, seg_end, per_seg_ai_budget)
        seg_metrics = r["metrics"]
        for t in r["trades"]:
            t["segment"] = idx
        for d in r["decisions"]:
            d["segment"] = idx
        all_trades.extend(r["trades"])
        all_decisions.extend(r["decisions"])
        # 段间复合拼接：各段曲线按此前累计收益因子缩放，边界处两段权益相等、无跳变
        for pt in r["equity_curve"]:
            stitched_curve.append(
                {
                    "time": pt.get("time"),
                    "equity": round(float(pt.get("equity") or 0) * compound_factor, 2),
                    "cash": round(float(pt.get("cash") or 0) * compound_factor, 2),
                    "unrealized": round(
                        float(pt.get("unrealized") or 0) * compound_factor, 2
                    ),
                }
            )
        if initial_cash > 0:
            compound_factor *= float(seg_metrics.get("final_equity") or 0) / initial_cash
        total_ai_calls += int(r["ai_calls"])
        total_bar_count += int(r["bar_count"])
        total_trade_bars += int(r["trade_bars"])
        total_realized += float(seg_metrics.get("realized_pnl") or 0)
        total_fees += float(seg_metrics.get("fees_paid") or 0)
        segment_reports.append(
            {
                "index": idx,
                "start_date": seg_start.isoformat(),
                "end_date": seg_end.isoformat(),
                "metrics": seg_metrics,
                "equity_curve": downsample_equity(r["equity_curve"], 400),
                "bars": r["bars"],
                "trades": r["trades"][-200:],
                "decisions": r["decisions"][-200:],
                "ai_calls": int(r["ai_calls"]),
                "bar_count": int(r["bar_count"]),
                "trade_bars": int(r["trade_bars"]),
                "message": summary_message(
                    seg_metrics, strategy_type, int(r["ai_calls"])
                ),
            }
        )

    final_stitched = (
        float(stitched_curve[-1].get("equity") or 0) if stitched_curve else initial_cash
    )
    agg_metrics = compute_metrics(
        stitched_curve,
        all_trades,
        initial_cash,
        final_stitched,
        total_realized,
        total_fees,
    )
    summary = multi_segment_summary([sr["metrics"] for sr in segment_reports])

    return {
        "status": "completed",
        "config": {
            **_base_config(),
            "segment_count": segment_count,
            "segment_ranges": [
                [s.isoformat(), e.isoformat()] for s, e in segments
            ],
            "ai_calls": total_ai_calls,
            "bar_count": total_bar_count,
            "trade_bars": total_trade_bars,
        },
        "metrics": {**agg_metrics, **summary},
        "segments": segment_reports,
        "equity_curve": downsample_equity(stitched_curve, 400),
        # 多段模式下 K 线请看各段明细（段间日期不连续，拼接图会误导）
        "bars": [],
        "trades": all_trades[-200:],
        "decisions": all_decisions[-200:],
        "message": multi_segment_message(summary, strategy_type, total_ai_calls),
    }


def _hold_days(open_time: str | None, bar_time: str) -> float | None:
    """粗略计算持仓天数（按 bar 时间字符串解析）"""
    if not open_time or not bar_time:
        return None
    from datetime import datetime

    def _parse(s: str) -> datetime | None:
        text = s.strip().replace("Z", "+00:00")
        for fmt in (
            "%Y-%m-%dT%H:%M:%S%z",
            "%Y-%m-%dT%H:%M:%S",
            "%Y-%m-%d %H:%M:%S",
            "%Y-%m-%d",
        ):
            try:
                return datetime.strptime(text[: len(fmt) + 8], fmt)
            except ValueError:
                continue
        try:
            return datetime.fromisoformat(text)
        except ValueError:
            return None

    a = _parse(open_time)
    b = _parse(bar_time)
    if a is None or b is None:
        return None
    return max(0.0, (b - a).total_seconds() / 86400.0)


def _swing_signal_for_ai(bars: list[dict[str, Any]]) -> dict[str, Any] | None:
    """为 AI 决策回测生成枢轴波段参考信号（正式确认模式，不偷看未来）。

    与 swing_pivot 策略口径一致：固定 min_right_live=right（默认 3），
    只取正式确认枢轴点（provisional 恒为 False），避免会消失的预确认
    信号误导 LLM。取最新枢轴点序列化为 prompt context。
    """
    if not bars:
        return None
    try:
        from signal_pivot import calc_pivot_signals

        # left=right=3 对齐图表与策略默认值；min_right_live=right 只出正式信号
        signals = calc_pivot_signals(bars, left=3, right=3, min_right_live=3)
    except Exception:
        logger.exception("回测 AI 注入枢轴波段信号失败")
        return None
    if not signals:
        return None
    last = signals[-1]
    last_idx = max(0, len(bars) - 1)
    pivot_idx = int(last.get("index") or 0)
    return {
        "side": str(last.get("side") or ""),
        "pivot_price": float(last.get("price") or 0),
        "price": float(bars[-1].get("close") or 0),
        "freshness": last_idx - pivot_idx,
        "provisional": bool(last.get("provisional")),
        "pivot_time": last.get("time"),
    }


