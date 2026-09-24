"""期货交易成本模型 —— 手续费 + 滑点

原先因子评估默认 cost=0.0003（3bp）是股票口径：只算了佣金量级，
没有把期货最小变动价位（tick）造成的滑点算进去。
短周期（尤其 1m）抢单时滑点通常远大于手续费，例如
rb 约 3000 元/吨、tick=1 元 → 单边滑点 3.3bp，已超过 3bp 的总成本假设。
低估成本会让遗传搜索偏爱高换手噪声因子，回测好看、实盘归零。

成本口径与 evaluate 对齐：evaluate 中 turnover=|Δposition|，
一次完整往返（空仓→满仓→空仓）turnover=2，因此本模块返回**单边**成本率。
手续费语义与 backtest/account.py 的 _fee 一致（rate=成交额比例，否则=元/手）。
"""

from __future__ import annotations

from data.product_specs import get_product_spec

# 默认滑点：1 个最小变动价位（流动主力合约短线的现实下限）
DEFAULT_SLIPPAGE_TICKS = 1.0


def fee_rate_one_way(symbol: str, price: float) -> float:
    """单边手续费率（成交额占比）

    rate 模式下 open_fee/close_fee 本身就是费率，一次往返各收一次，
    折到单位 turnover 上即两者均值。
    非 rate 模式为元/手，按 price×multiplier 折算成费率。
    """
    spec = get_product_spec(symbol)
    open_fee = float(spec.get("open_fee") or 0.0)
    close_fee = float(spec.get("close_fee") or 0.0)
    avg_fee = (open_fee + close_fee) / 2.0
    if str(spec.get("fee_mode") or "rate") == "rate":
        return avg_fee
    multiplier = float(spec.get("multiplier") or 0.0)
    notional = price * multiplier
    if notional <= 0:
        return 0.0
    return avg_fee / notional


def slippage_rate_one_way(symbol: str, price: float, slippage_ticks: float) -> float:
    """单边滑点率 = 滑点跳数 × tick / 价格"""
    if price <= 0:
        return 0.0
    tick_size = float(get_product_spec(symbol).get("tick_size") or 0.0)
    if tick_size <= 0:
        return 0.0
    return slippage_ticks * tick_size / price


def turnover_cost_rate(symbol: str, price: float, slippage_ticks: float) -> float:
    """单位 turnover 的总成本率 —— 直接作为 evaluate_factor 的 cost"""
    return fee_rate_one_way(symbol, price) + slippage_rate_one_way(
        symbol, price, slippage_ticks
    )
