"""Funding 事件现金流(crypto_local_v2,方案 §7.2)

背景(方案 2.1-G):Gate 加入的 funding_rate 目前只作特征;评估口径仍是
"收益减换手静态成本"。本模块把资金费率从"输入特征"升级为"结算现金流":

    cashflow_at_settlement = - signed_position_before_settlement
                             × contract_multiplier
                             × settlement_mark_price
                             × funding_rate

关键纪律:
- 只适用于本阶段支持的线性(USDT 本位)合约;反向合约明确不支持;
- 正费率多头付费、空头收款;零持仓零现金流;
- 事件按 funding_time 去重:前填到多根 bar 的同一费率只结算一次,
  不用日线前填值假装重建了当天所有结算(覆盖率标注 partial);
- 同时间戳开仓与结算的保守排序:先对结算前已持仓计费,再处理新订单
  (由调用方传入"结算前持仓"实现);
- 历史结算标记价缺失时用结算前最近已知收盘价估算,显式标注
  estimated=True,不得宣称精确计费。

特征层(FUNDING_RATE,known-at 保守时延)与本模块的真实扣费事件分开:
前者用于预测,后者用于现金流,互不混用。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import numpy as np


@dataclass(frozen=True)
class FundingEvent:
    """一次真实结算事件(venue/contract 元数据由 bars 的 market_source 承载)"""

    settled_at_ms: float        # 结算时刻(UTC 毫秒)
    rate: float
    attach_bar: int             # 事件首次被观测到的 bar 索引(该 bar 开盘前已结算)
    venue: str = "gate_usdt"
    contract: str = ""


def extract_funding_events(bars: list[dict[str, Any]]) -> list[FundingEvent]:
    """从 bars 提取去重后的结算事件。

    数据层(joinGateHistory)把"最近一次已公布费率"前填到每根 bar,并带
    funding_time(该事件的真实结算时间戳)。funding_time 变化 = 新事件;
    不变的 = 前填,不是新结算,不得重复扣款。
    """
    events: list[FundingEvent] = []
    last_t: float | None = None
    venue = ""
    for i, b in enumerate(bars):
        t = b.get("funding_time")
        r = b.get("funding_rate")
        if t is None or r is None:
            continue
        t = float(t)
        if last_t is not None and t == last_t:
            continue  # 前填的同一事件
        if last_t is not None and t < last_t:
            continue  # 时间戳乱序:防御,不按新事件处理
        last_t = t
        if not venue:
            venue = str(b.get("market_source") or "")
        events.append(FundingEvent(settled_at_ms=t, rate=float(r), attach_bar=i, venue=venue))
    return events


def funding_cashflows(
    bars: list[dict[str, Any]],
    held_positions: np.ndarray,
    events: list[FundingEvent],
    contract_multiplier: float = 1.0,
) -> dict[str, Any]:
    """按事件计算现金流,对齐到 bar 索引。

    held_positions[i]:bar i 开盘时刻(结算重合时为"结算前")的持仓。
    调用方负责保守排序——把结算前持仓(而非新订单后持仓)传入本函数。

    标记价缺失:用结算前最近已知收盘价(close[attach_bar-1])估算,
    estimated=True(不得宣称精确)。attach_bar==0 时无已知前价,该事件
    记 NaN 并计入 missing。

    返回:{cashflows[n], returns[n], estimated, n_events, missing, total, rate_sum}
    - cashflows:每单位持仓的计价币金额(−pos×乘数×标记价×费率),报告用;
    - returns:同一事件折成收益率(−pos×乘数×费率),与价格收益同量纲,
      执行口径 pnl 只能加它——直接加金额会把费率放大"标记价"倍
      (BTC 约 7 万倍),可执行 sortino 被资金费率完全主导。
    """
    n = len(bars)
    cf = np.zeros(n, dtype=float)
    cf_ret = np.zeros(n, dtype=float)
    estimated = 0
    missing = 0
    closes = np.array([float(b.get("close") or 0) for b in bars], dtype=float)
    opens_ms = np.array([float(b.get("open_time") or 0) for b in bars], dtype=float)
    for ev in events:
        i = ev.attach_bar
        if i <= 0 or i >= n:
            if i == 0:
                # 序列首根之前结算:无已知前价,无法估算
                missing += 1
                continue
            i = n - 1
        # 保守排序:结算时刻恰为 bar 开盘(与换仓订单同戳)时,先对
        # 结算前持仓计费——即上一根期间的持仓,而非本根订单后的新仓
        if i >= 2 and abs(opens_ms[i - 1] - ev.settled_at_ms) < 1e-6:
            pos = float(held_positions[i - 2])
        else:
            pos = float(held_positions[i - 1])
        mark = float(closes[i - 1]) if closes[i - 1] > 0 else None
        if mark is None:
            missing += 1
            continue
        # 估算口径:结算价用结算前最近收盘。真实标记价缺失 → estimated
        estimated += 1
        cf[i] += -pos * contract_multiplier * mark * float(ev.rate)
        cf_ret[i] += -pos * contract_multiplier * float(ev.rate)
    return {
        "cashflows": cf,
        "returns": cf_ret,
        "estimated": estimated,
        "missing": missing,
        "n_events": len(events),
        "total": float(cf.sum()),
        "rate_sum": float(sum(ev.rate for ev in events)),
        "coverage": (
            "settlement_timestamps"
            if events
            else "none"
        ),
    }


def events_per_bar_summary(bars: list[dict[str, Any]]) -> dict[str, Any]:
    """数据能力诊断:结算事件数、名义 bar 数、前填倍数。"""
    events = extract_funding_events(bars)
    with_field = sum(1 for b in bars if b.get("funding_rate") is not None)
    return {
        "n_settlement_events": len(events),
        "bars_with_funding": with_field,
        "ffill_ratio": round(with_field / max(len(events), 1), 3),
        "first_event_ms": events[0].settled_at_ms if events else None,
        "last_event_ms": events[-1].settled_at_ms if events else None,
    }
