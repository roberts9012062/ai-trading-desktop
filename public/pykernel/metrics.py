"""回测指标计算 —— 纯函数（含风险调整指标，因子评估共用）"""

from __future__ import annotations

from typing import Any

# 默认年化周期：国内期货日线约 243 个交易日
PERIODS_PER_YEAR_DAILY = 243


def _equity_to_returns(equity_curve: list[dict[str, Any]]) -> list[float]:
    """从权益曲线推相邻 bar 收益率"""
    eqs = [float(pt.get("equity") or 0) for pt in equity_curve]
    if len(eqs) < 2:
        return []
    out: list[float] = []
    for i in range(1, len(eqs)):
        prev = eqs[i - 1]
        out.append((eqs[i] - prev) / prev if prev > 0 else 0.0)
    return out


def sharpe_ratio(
    returns: list[float],
    periods_per_year: int,
    rf: float = 0.0,
) -> float:
    """年化夏普"""
    n = len(returns)
    if n < 2:
        return 0.0
    mean = sum(returns) / n - rf
    var = sum((r - mean) ** 2 for r in returns) / n
    std = var ** 0.5
    if std < 1e-9:
        return 0.0
    return mean / std * (periods_per_year ** 0.5)


def sortino_ratio(
    returns: list[float],
    periods_per_year: int,
    rf: float = 0.0,
) -> float:
    """年化索提诺（下行风险）"""
    n = len(returns)
    if n < 2:
        return 0.0
    mean = sum(returns) / n - rf
    downside = [r for r in returns if r < 0]
    if not downside:
        return 20.0 if mean > 0 else 0.0
    dstd = (sum(r ** 2 for r in downside) / len(downside)) ** 0.5
    if dstd < 1e-9:
        return 0.0
    raw = mean / dstd * (periods_per_year ** 0.5)
    return max(-20.0, min(20.0, raw))


def calmar_ratio(returns: list[float], periods_per_year: int) -> float:
    """年化收益 / 最大回撤"""
    if not returns:
        return 0.0
    cum = [0.0]
    for r in returns:
        cum.append(cum[-1] + r)
    peak = cum[0]
    mdd = 0.0
    for v in cum:
        if v > peak:
            peak = v
        dd = peak - v
        if dd > mdd:
            mdd = dd
    ann = sum(returns) / len(returns) * periods_per_year
    if mdd < 1e-9:
        return 10.0 if cum[-1] > 0 else 0.0
    return max(-10.0, min(10.0, ann / mdd))


def annualized_return_pct(returns: list[float], periods_per_year: int) -> float:
    """年化收益率（%）"""
    if not returns:
        return 0.0
    return sum(returns) / len(returns) * periods_per_year * 100.0


def turnover_rate(positions: list[float]) -> float:
    """平均换手率（|Δposition| 均值）"""
    if len(positions) < 2:
        return 0.0
    return (
        sum(abs(positions[i] - positions[i - 1]) for i in range(1, len(positions)))
        / (len(positions) - 1)
    )


def compute_metrics(
    equity_curve: list[dict[str, Any]],
    trades: list[dict[str, Any]],
    initial_cash: float,
    final_equity: float,
    realized_pnl: float,
    fees_paid: float,
    periods_per_year: int = PERIODS_PER_YEAR_DAILY,
) -> dict[str, Any]:
    """汇总收益、回撤、胜率及风险调整指标"""
    peak = initial_cash
    max_dd = 0.0
    max_dd_pct = 0.0
    for pt in equity_curve:
        eq = float(pt.get("equity") or 0)
        if eq > peak:
            peak = eq
        dd = peak - eq
        if dd > max_dd:
            max_dd = dd
        if peak > 0:
            dd_pct = dd / peak * 100
            if dd_pct > max_dd_pct:
                max_dd_pct = dd_pct

    closes = [t for t in trades if t.get("action") == "close"]
    wins = [t for t in closes if float(t.get("pnl") or 0) > 0]
    losses = [t for t in closes if float(t.get("pnl") or 0) < 0]
    win_pnl = sum(float(t.get("pnl") or 0) for t in wins)
    loss_pnl = sum(float(t.get("pnl") or 0) for t in losses)

    total_return = final_equity - initial_cash
    total_return_pct = (total_return / initial_cash * 100) if initial_cash else 0.0

    returns = _equity_to_returns(equity_curve)

    return {
        "initial_cash": round(initial_cash, 2),
        "final_equity": round(final_equity, 2),
        "total_return": round(total_return, 2),
        "total_return_pct": round(total_return_pct, 4),
        "annualized_return_pct": round(
            annualized_return_pct(returns, periods_per_year), 4
        ),
        "realized_pnl": round(realized_pnl, 2),
        "fees_paid": round(fees_paid, 2),
        "max_drawdown": round(max_dd, 2),
        "max_drawdown_pct": round(max_dd_pct, 4),
        "sharpe": round(sharpe_ratio(returns, periods_per_year), 4),
        "sortino": round(sortino_ratio(returns, periods_per_year), 4),
        "calmar": round(calmar_ratio(returns, periods_per_year), 4),
        "trade_count": len(trades),
        "close_count": len(closes),
        "win_count": len(wins),
        "loss_count": len(losses),
        "win_rate": round(len(wins) / len(closes) * 100, 2) if closes else 0.0,
        "avg_win": round(win_pnl / len(wins), 2) if wins else 0.0,
        "avg_loss": round(loss_pnl / len(losses), 2) if losses else 0.0,
        "profit_factor": (
            round(abs(win_pnl / loss_pnl), 4)
            if loss_pnl < 0
            else (999.0 if win_pnl > 0 else 0.0)
        ),
    }


def downsample_equity(
    curve: list[dict[str, Any]],
    max_points: int,
) -> list[dict[str, Any]]:
    """权益曲线降采样，避免前端过大"""
    if len(curve) <= max_points:
        return curve
    step = max(1, len(curve) // max_points)
    out = curve[::step]
    if out[-1] is not curve[-1]:
        out.append(curve[-1])
    return out


def summary_message(
    metrics: dict[str, Any],
    strategy_type: str,
    ai_calls: int,
) -> str:
    """报告顶部一句话摘要"""
    ret = metrics.get("total_return", 0)
    pct = metrics.get("total_return_pct", 0)
    dd = metrics.get("max_drawdown_pct", 0)
    wr = metrics.get("win_rate", 0)
    sor = metrics.get("sortino", 0)
    base = (
        f"回测完成：收益 {ret:+.2f} 元（{pct:+.2f}%），"
        f"最大回撤 {dd:.2f}%，胜率 {wr:.1f}%，Sortino {sor:.2f}"
    )
    if strategy_type == "ai":
        base += f"；AI 调用 {ai_calls} 次（抽样）"
    return base


def multi_segment_summary(segment_metrics: list[dict[str, Any]]) -> dict[str, Any]:
    """多段回测的段级汇总：各段独立结算后复合/平均，反映策略跨期稳定性"""
    n = len(segment_metrics)
    if n == 0:
        return {}
    rets = [float(m.get("total_return_pct") or 0) for m in segment_metrics]
    winning = sum(1 for r in rets if r > 0)
    compound = 1.0
    for r in rets:
        compound *= 1.0 + r / 100.0
    return {
        "segment_count": n,
        "winning_segments": winning,
        "segment_win_rate": round(winning / n * 100, 2),
        "mean_segment_return_pct": round(sum(rets) / n, 4),
        "compound_return_pct": round((compound - 1.0) * 100.0, 4),
        "best_segment_return_pct": round(max(rets), 4),
        "worst_segment_return_pct": round(min(rets), 4),
        "mean_segment_drawdown_pct": round(
            sum(float(m.get("max_drawdown_pct") or 0) for m in segment_metrics) / n, 4
        ),
    }


def multi_segment_message(
    summary: dict[str, Any],
    strategy_type: str,
    ai_calls: int,
) -> str:
    """多段报告顶部一句话摘要"""
    n = int(summary.get("segment_count") or 0)
    msg = (
        f"{n} 段随机回测完成：复合收益 {float(summary.get('compound_return_pct') or 0):+.2f}%，"
        f"平均段收益 {float(summary.get('mean_segment_return_pct') or 0):+.2f}%，"
        f"盈利段 {int(summary.get('winning_segments') or 0)}/{n}，"
        f"平均最大回撤 {float(summary.get('mean_segment_drawdown_pct') or 0):.2f}%"
    )
    if strategy_type == "ai":
        msg += f"；AI 调用 {ai_calls} 次（按段均分抽样）"
    return msg
