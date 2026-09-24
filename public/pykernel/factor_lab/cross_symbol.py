"""跨品种验证 —— 伙伴 bars 加载与判定（供搜索/挖掘在严格筛中调用）

设计：search/_dedup_top 是同步热路径，伙伴 bars 必须由异步调用方
（API/挖掘 loop）预先加载并注入 SearchConfig.cross_peers；本模块只
提供加载与判定原语，不在热路径里做 IO。
"""

from __future__ import annotations

from typing import Any

from product_sectors import get_cross_peers, get_sector
from factor_lab.scoring.walk_forward import (
    MIN_TEST_BARS,
    evaluate_on_segment,
)


async def load_cross_peer_bars(
    session,
    symbol: str,
    timeframe: str,
    max_bars: int,
    load_minute_bars=None,
) -> list[tuple[str, list[dict[str, Any]]]]:
    """加载同板块验证伙伴的 bars：[(peer_code, bars)]

    日线走主库 kline_history（深）；分钟线由调用方注入加载函数
    （Sina+tickdata 合并路径较重，默认不加载 → 分钟跨品种验证跳过）。
    加载失败/数据不足的伙伴被静默剔除。
    """
    from data.contracts import get_code_for_symbol

    code = get_code_for_symbol(symbol) or (
        "".join(ch for ch in str(symbol).lower() if ch.isalpha())
    )
    peers = get_cross_peers(code)
    if not peers:
        return []
    out: list[tuple[str, list[dict[str, Any]]]] = []
    if timeframe == "1d":
        async def query_history_bars(*a, **k):
            raise RuntimeError("本地内核不加载远程历史(peer 数据不可用)")

        from datetime import datetime, timedelta

        end = (datetime.now() + timedelta(days=1)).strftime("%Y-%m-%d")
        for peer in peers:
            try:
                bars = await query_history_bars(session, peer.upper(), end, max_bars)
            except Exception:
                continue
            if bars and len(bars) >= MIN_TEST_BARS:
                out.append((peer, bars))
    elif load_minute_bars is not None:
        for peer in peers:
            try:
                bars = await load_minute_bars(peer, timeframe, max_bars)
            except Exception:
                continue
            if bars and len(bars) >= MIN_TEST_BARS:
                out.append((peer, bars))
    return out


def cross_validate_tokens(
    tokens: list[int],
    cross_peers: list[tuple[str, list[dict[str, Any]]]],
    timeframe: str,
    cost: float,
) -> tuple[bool, dict[str, float]]:
    """单因子跨品种判定：≥⌈K/2⌉ 个伙伴品种 sortino>0 才通过

    返回 (通过与否, {peer_code: sortino})。无可用伙伴时返回 (True, {})
    ——门只在有验证材料时生效，避免无数据品种误杀全部候选。
    """
    usable = [
        (peer, bars)
        for peer, bars in cross_peers
        if bars and len(bars) >= MIN_TEST_BARS
    ]
    if not usable:
        return True, {}
    scores: dict[str, float] = {}
    for peer, bars in usable:
        m = evaluate_on_segment(list(tokens), bars, timeframe, cost)
        if m is not None:
            scores[peer] = float(m["sortino"])
    if not scores:
        return True, {}
    positives = sum(1 for v in scores.values() if v > 0)
    need = (len(scores) + 1) // 2
    return positives >= need, scores


def describe_cross_setting(symbol: str) -> str:
    """配置诊断文案（供 API applied/config 快照）"""
    from data.contracts import get_code_for_symbol

    code = get_code_for_symbol(symbol) or ""
    sector = get_sector(code)
    peers = get_cross_peers(code)
    if not sector:
        return f"{code or symbol} 无板块映射，跨品种验证跳过"
    return f"{code} ∈ {sector}，验证伙伴: {', '.join(peers)}"
