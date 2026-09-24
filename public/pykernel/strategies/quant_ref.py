"""AI 决策参考信号 —— 用户多选的量化策略信号序列化注入

AI 任务创建时用户可多选规则量化策略（不包含 factor，因子走独立挂载），
实时引擎与 AI 回测按这些策略的默认参数计算当前信号，序列化为轻量快照
注入 prompt context.quant_ref_signals，作为 AI 决策的量化参考。

每个策略复用 compute_quant_signal（与量化任务同一套信号口径），
只抽取 action/reason/关键快照，避免把完整信号结构膨胀进 prompt。
"""

from __future__ import annotations

from typing import Any

from strategies import compute_quant_signal

# AI 参考策略白名单：6 个规则量化策略（factor 走独立挂载入口，不在此列）
QUANT_REF_KINDS: tuple[str, ...] = (
    "ma_cross",
    "n_breakout",
    "macd_cross",
    "kdj_cross",
    "band_swing",
    "swing_pivot",
)

# 各策略信号结果中的快照键（signal_result 结构）
_SNAP_KEYS: dict[str, str] = {
    "ma_cross": "ma_snapshot",
    "n_breakout": "breakout_snapshot",
    "macd_cross": "macd_snapshot",
    "kdj_cross": "kdj_snapshot",
    "band_swing": "band_snapshot",
    "swing_pivot": "swing_snapshot",
}

# 快照中保留给 AI 的键（裁剪 index/bar_time 等时序噪音，防 prompt 膨胀）
_DETAIL_KEYS: dict[str, tuple[str, ...]] = {
    "ma_cross": ("fast_period", "slow_period", "fast_now", "slow_now", "close"),
    "n_breakout": ("lookback", "upper", "lower", "close"),
    "macd_cross": ("fast_period", "slow_period", "signal_period", "dif_now", "dea_now", "hist_now"),
    "kdj_cross": ("n_period", "k_period", "d_period", "k_now", "d_now", "j_now"),
    "band_swing": ("period", "std_mult", "upper", "middle", "lower", "close"),
    "swing_pivot": (
        "left",
        "right",
        "min_right_live",
        "close",
        "last_pivot",
        "freshness",
    ),
}


def quant_ref_snapshot(
    kind: str,
    bars: list[dict[str, Any]],
    params: dict[str, Any] | None = None,
) -> dict[str, Any] | None:
    """计算单个策略的 AI 参考信号快照。

    kind 不在白名单时返回 None（调用方跳过）。
    bars 为空时返回 None，避免策略内部越界。
    """
    st = str(kind or "").strip().lower()
    if st not in QUANT_REF_KINDS or not bars:
        return None
    try:
        sig = compute_quant_signal(st, bars, params or {}, "both", None)
    except Exception:
        return None
    if not isinstance(sig, dict) or not sig.get("parse_ok", False):
        return None
    detail: dict[str, Any] | None = None
    snap = sig.get(_SNAP_KEYS.get(st, ""))
    if isinstance(snap, dict):
        keep = _DETAIL_KEYS.get(st, ())
        detail = {k: snap.get(k) for k in keep if k in snap}
    return {
        "kind": st,
        "action": str(sig.get("action") or "hold"),
        "signal": str(sig.get("signal") or "none"),
        "reason": str(sig.get("reason") or ""),
        "close": float(bars[-1].get("close") or 0),
        "detail": detail,
    }


def normalize_ref_strategies(raw: Any) -> list[dict[str, Any]]:
    """校验并规范化用户多选的参考策略列表。

    过滤非法 kind、去重；params 仅保留 dict（缺省为 None，用策略默认参数）。
    返回可安全写入 strategy_params.ref_strategies 的列表。
    """
    if not isinstance(raw, list):
        return []
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in raw:
        if not isinstance(item, dict):
            continue
        kind = str(item.get("kind") or "").strip().lower()
        if kind not in QUANT_REF_KINDS or kind in seen:
            continue
        seen.add(kind)
        params = item.get("params")
        out.append(
            {"kind": kind, "params": params if isinstance(params, dict) else None}
        )
    return out


def build_quant_ref_signals(
    ref_strategies: list[dict[str, Any]] | None,
    bars: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """遍历用户多选策略生成参考信号列表；非法 kind / 异常策略静默跳过。

    ref_strategies 形如 [{"kind": "swing_pivot", "params": {...}}, ...]，
    params 缺省时用策略默认参数（与量化任务表单默认一致）。
    """
    if not ref_strategies or not bars:
        return []
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in ref_strategies:
        if not isinstance(item, dict):
            continue
        kind = str(item.get("kind") or "").strip().lower()
        if kind in seen:
            continue  # 去重：同一策略只注入一次
        seen.add(kind)
        params = item.get("params")
        snap = quant_ref_snapshot(kind, bars, params if isinstance(params, dict) else None)
        if snap is not None:
            out.append(snap)
    return out
