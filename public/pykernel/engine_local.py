"""Pyodide AI 交易本地引擎入口:bar 对齐 / 量化信号 / AI prompt 构建 / 决策解析

客户端调度循环每 tick 调用;决策结果由 TS 侧提交服务端 client-decision 端点
(撮合/账本/审计在服务端)。全部函数与服务端逐字同源(bar_align.py/prompts.py/
strategies 原样拷贝)。
"""

from __future__ import annotations

import json
from typing import Any

from bar_align import extract_closed_bar, should_run_for_bar
from prompts import build_system_prompt, build_user_prompt, parse_decision_text
from strategies import compute_quant_signal


def run(payload_json: str, arg_json: str) -> str:
    p = json.loads(payload_json)
    op = str(p.get("op") or "")
    arg = json.loads(arg_json)

    if op == "should_run":
        bars = arg.get("bars") or []
        bar = extract_closed_bar(bars, arg.get("last_bar_time"))
        hit = should_run_for_bar(bars, arg.get("last_bar_time"))
        return json.dumps({"run": bool(hit), "bar_time": str((bar or {}).get("time") or "")})

    if op == "quant_signal":
        sig = compute_quant_signal(
            str(p.get("strategy") or ""),
            arg.get("bars") or [],
            dict(p.get("params") or {}),
            str(p.get("side_mode") or "both"),
            arg.get("position"),
        )
        return json.dumps(sig, ensure_ascii=False, default=str)

    if op == "build_ai_prompt":
        kw = {
            "risk_style": str(arg.get("risk_style") or "balanced"),
            "timeframe": str(arg.get("timeframe") or "5m"),
            "max_hold_days": int(arg.get("max_hold_days") or 10),
            "horizon": str(arg.get("horizon") or ""),
            "allocated_capital": float(arg.get("allocated_capital") or 0),
            "custom_prompt_enabled": bool(arg.get("custom_prompt_enabled")),
            "custom_prompt": arg.get("custom_prompt"),
        }
        kw.setdefault("has_factor_signal", bool(kw.get("custom_prompt_enabled")))
        kw.setdefault("has_swing_signal", False)
        for k in ("user_max_hold_days", "style_hint", "effective_close_rules", "effective_stop_rules", "has_quant_ref_signals"):
            if arg.get(k) is not None:
                kw[k] = arg.get(k)
        system = build_system_prompt(**kw)
        user = build_user_prompt(dict(arg.get("context") or {}))
        return json.dumps({"system": system, "user": user}, ensure_ascii=False)

    if op == "parse_ai_decision":
        d = parse_decision_text(str(arg.get("text") or ""))
        return json.dumps(d, ensure_ascii=False, default=str)

    return json.dumps({"error": f"unknown op: {op}"})


def kernel_version() -> str:
    return "pykernel-engine-2026-08-21.1"
