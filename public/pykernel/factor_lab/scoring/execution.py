"""可执行收益现金流(crypto_local_v2,方案 §7.1)

时间与成本约定:
- bar t 闭合后产生信号,最早于 t+1 开盘执行;持有至下一次换仓执行时点。
  同一索引同时定义:特征可用(收盘 t)、信号(收盘 t)、订单(open t+1)、
  收益归属(open t+1 → open t+2)。
- 手续费/滑点分别配置;2 倍压力仅放大交易费用/滑点,资金费率按历史
  事件原值计算。
- 现货 long_flat:仓位截断到 [0,1],不输出可执行做空收益。
- 切片一致性:分段评估通过上下文连续推进(与全段现金流逐位一致),
  切片首部不重复计入开仓成本。
- 保守排序:结算时刻与开仓同戳时,先对结算前持仓计费再处理新订单
  (funding_cashflows 接收"结算前持仓"实现)。

旧 signal_research 口径(连续 tanh + 收盘收益 + 静态换手成本)保留为对照,
由 evaluate.py 提供;本模块是可执行口径的权威实现。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import numpy as np

from .evaluate import _calmar, _sortino, position_from_factor
from .funding import extract_funding_events, funding_cashflows
from .periods import bars_per_year

# 执行模型(与 research_context 的枚举一致)
MODEL_SIGNAL_RESEARCH = "signal_research"
MODEL_SPOT_LONG_FLAT = "spot_long_flat"
MODEL_PERP_NEXT_OPEN = "perp_next_open"


@dataclass(frozen=True)
class ExecutionConfig:
    """可执行成本配置(首版:明确单边费率 + 固定 bps 滑点)。"""

    fee_rate: float = 0.0005          # 单边手续费率(taker)
    slippage_bps: float = 2.0         # 单边滑点(bps)
    execution_model: str = MODEL_PERP_NEXT_OPEN
    stress_multiplier: float = 1.0    # 仅放大 fee+slippage,不动 funding
    contract_multiplier: float = 1.0  # 线性 USDT 合约=1

    @property
    def unit_cost(self) -> float:
        return (self.fee_rate + self.slippage_bps * 1e-4) * self.stress_multiplier


def executable_cashflows(
    factor: np.ndarray,
    bars: list[dict[str, Any]],
    cfg: ExecutionConfig,
) -> dict[str, Any] | None:
    """perp_next_open 执行现金流。因子无效返回 None。

    索引约定(全段连续,切片由调用方取子区间):
    - sig[t] = tanh 仓位目标(信号在收盘 t 产生)
    - held[k] = sig[k-1]:bar k 期间持仓(open k 成交,open k+1 前不变);
      held[0] = 0(首根收盘前无信号)
    - fee[k] = |sig[k-1] - sig[k-2]| × unit_cost(k=0 为 0;k=1 从空仓起算)
    - price_ret[k] = (open[k+1] - open[k]) / open[k](末根为 0,无完整区间)
    - funding_cf[k]:结算事件按名义本金折成的收益率(−持仓×费率,见 funding.py
      returns;与 price_ret 同量纲。计价币金额不能直接加进收益率)
    """
    factor = np.asarray(factor, dtype=float)
    n = len(bars)
    if len(factor) != n or n < 3:
        return None
    sig = position_from_factor(factor)
    if cfg.execution_model == MODEL_SPOT_LONG_FLAT:
        sig = np.clip(sig, 0.0, 1.0)  # 现货多头:不做空
    held = np.concatenate([[0.0], sig[:-1]])  # held[k] = sig[k-1]
    opens = np.array([float(b.get("open") or 0) for b in bars], dtype=float)
    if np.any(opens <= 0):
        return None
    # 收益归属:bar k 从 open k 持有到 open k+1(换仓发生在开盘)
    price_ret = np.zeros(n, dtype=float)
    price_ret[:-1] = (opens[1:] - opens[:-1]) / opens[:-1]
    # 换手与费用:第 k 根开盘执行的订单 = sig[k-1] - sig[k-2]
    prev_sig = np.concatenate([[0.0, 0.0], sig[:-2]])  # sig[k-2],前两根补 0
    delta = np.concatenate([[0.0], sig[:-1]]) - prev_sig
    fee = np.abs(delta) * cfg.unit_cost
    # funding:结算前持仓 = held(重合时上一根的持仓,保守排序)
    events = extract_funding_events(bars)
    funding = {"returns": np.zeros(n), "n_events": 0, "estimated": 0, "missing": 0}
    if cfg.execution_model == MODEL_PERP_NEXT_OPEN and events:
        funding = funding_cashflows(bars, held, events, cfg.contract_multiplier)
    elif cfg.execution_model == MODEL_PERP_NEXT_OPEN:
        funding = {"returns": np.zeros(n), "n_events": 0, "estimated": 0, "missing": 0,
                   "no_funding_data": True}
    pnl = held * price_ret - fee + funding["returns"]
    return {
        "pnl": pnl,
        "held": held,
        "fee": fee,
        "funding_cf": funding["returns"],
        "funding_estimated": int(funding.get("estimated", 0)),
        "funding_missing": int(funding.get("missing", 0)),
        "n_funding_events": int(funding.get("n_events", 0)),
        "no_funding_data": bool(funding.get("no_funding_data", False)),
        "avg_turnover": float(np.abs(delta).mean()),
    }


def executable_metrics(
    factor: np.ndarray,
    bars: list[dict[str, Any]],
    timeframe: str,
    cfg: ExecutionConfig,
    lo: int = 0,
    hi: int | None = None,
) -> dict[str, Any] | None:
    """可执行口径指标(支持 [lo, hi) 子区间;现金流全段连续推进后取段)。

    全段/分段一致性:分段调用本函数与全段结果取同一子区间逐位一致
    (费用/funding 均在连续时间线上计算,切片不重计入开仓成本)。
    """
    flows = executable_cashflows(factor, bars, cfg)
    if flows is None:
        return None
    hi = len(bars) if hi is None else hi
    if hi - lo < 2:
        return None
    pnl = flows["pnl"][lo:hi]
    periods = bars_per_year(bars[lo:hi], timeframe)
    m = {
        "ann_ret": float(pnl.mean() * periods),
        "sortino": float(_sortino(pnl, periods)),
        "calmar": float(_calmar(pnl, periods)),
        "avg_turnover": float(flows["avg_turnover"]),
        "exposure": float(np.abs(flows["held"][lo:hi]).mean()),
        "fee_total": float(flows["fee"][lo:hi].sum()),
        "funding_total": float(flows["funding_cf"][lo:hi].sum()),
        "n_funding_events": flows["n_funding_events"],
        "funding_estimated": flows["funding_estimated"],
        "execution_model": cfg.execution_model,
        "stress_multiplier": cfg.stress_multiplier,
        "bars": float(hi - lo),
    }
    return m
