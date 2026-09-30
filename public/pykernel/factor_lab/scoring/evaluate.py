"""因子多目标评估 —— 纯 numpy 向量化

仓位口径：position = tanh(factor)，|position|<阈值 视为空仓。
pnl[t] = position[t] * next_ret[t] - |Δposition|*cost（与收盘撮合一致）。
评分含年化、Sortino、Calmar、ts_IC、对称性、换手质量、OOS 门控、半段一致性。

年化基数 periods 必须由调用方显式传入（见 periods.bars_per_year）：
分钟周期与日线差 6~345 倍，一旦沿用日线 243 会把收益项整体压平，
使搜索退化为「优化对称性与低换手」。故此处不提供默认值。
"""

from __future__ import annotations

import math
from typing import Any

import numpy as np

NEUTRAL_BAND = 0.05
# 换手退化阈值：平均每根 bar 的 |Δposition| 超过 1 视为反手过频
MAX_SANE_TURNOVER = 1.0


def position_from_factor(
    factor: np.ndarray,
    neutral: float = NEUTRAL_BAND,
) -> np.ndarray:
    """因子 → 连续仓位"""
    pos = np.tanh(np.clip(np.asarray(factor, dtype=float), -3.0, 3.0))
    pos[np.abs(pos) < neutral] = 0.0
    return pos


# 实盘因子策略的入场/平仓阈值（ai_trading/strategies/factor.py）
LIVE_ENTRY = 0.3
LIVE_NEUTRAL = 0.05


def position_live_discrete(
    factor: np.ndarray,
    entry: float = LIVE_ENTRY,
    neutral: float = LIVE_NEUTRAL,
) -> np.ndarray:
    """实盘口径仓位：±1 全进全出 + 迟滞状态机

    复刻 factor.py 的离散逻辑：|pos|>entry 开仓（±1），|pos|<neutral 平仓，
    中间带维持原状态。含迟滞，需逐 bar 推进（仅用于报告，不进 GA 热路径）。
    """
    cont = position_from_factor(factor)
    out = np.zeros_like(cont)
    state = 0.0
    for i, p in enumerate(cont):
        if abs(p) < neutral:
            state = 0.0
        elif p > entry:
            state = 1.0
        elif p < -entry:
            state = -1.0
        out[i] = state
    return out


def evaluate_factor_live(
    factor: np.ndarray,
    close: np.ndarray,
    cost: float,
    periods: int,
) -> dict[str, Any]:
    """实盘离散口径指标（±1 手、0.3 入场、0.05 平仓）

    回测的连续 tanh 仓位无法在实盘复现（固定手数 + 入场阈值），
    本函数给出"按实盘规则执行该因子"的年化/Sortino，供回测响应展示，
    让用户直接看到可实现收益而非连续仓位理论值。非 GA 适应度。
    """
    pos = position_live_discrete(factor)
    ret = next_ret(close)
    prev = np.roll(pos, 1)
    prev[0] = 0.0
    turnover = np.abs(pos - prev)
    pnl = pos * ret - turnover * cost
    ann = float(pnl.mean() * periods)
    # 开仓次数（状态变化即一次交易：含 0→±1 开仓与 +1→-1 直接反手。
    # 此前只计从空仓开出的,直接反手漏计——P2-10）
    n_trades = int(np.sum((pos != 0) & (pos != prev)))
    return {
        "ann_ret": ann,
        "sortino": _sortino(pnl, periods),
        "calmar": _calmar(pnl, periods),
        "avg_turnover": float(turnover.mean()),
        "exposure": float(np.abs(pos).mean()),
        "n_trades": n_trades,
    }


def next_ret(close: np.ndarray) -> np.ndarray:
    """对齐到 t 的下一根收益率（最后一根为 0）"""
    close = np.asarray(close, dtype=float)
    ret = np.zeros_like(close)
    ret[:-1] = (close[1:] - close[:-1]) / np.maximum(np.abs(close[:-1]), 1e-9)
    return ret


def session_open_mask(bars: list[dict]) -> np.ndarray:
    """时段边界 bar 掩码（分钟周期）：与前一 bar 间隔 >150 分钟。

    实盘 session_close 语义在交易日结束时平仓、次日按信号重进——
    边界 bar 的收益应按 open→close 计（进场于开盘），而非跨边界
    close→close（后者把隔夜跳空计入持仓收益）。150 分钟阈值：
    午休恰好 2 小时（保留持仓）、10:15 小节 15 分钟（保留）；
    日盘收→夜盘开（6h）、夜盘收→日盘开（≥6.5h）均越过阈值。
    日线 bar 无有效间隔信息时全 False（口径退化为收盘对收盘）。
    """
    from datetime import datetime

    n = len(bars)
    mask = np.zeros(n, dtype=bool)
    times: list[datetime | None] = []
    for b in bars:
        t = str(b.get("time") or "")
        if len(t) < 16:
            times.append(None)  # 日线无时钟：不参与边界判定
            continue
        try:
            times.append(datetime.fromisoformat(t[:16]))
        except ValueError:
            times.append(None)
    for i in range(1, n):
        if times[i] is None or times[i - 1] is None:
            continue
        if (times[i] - times[i - 1]).total_seconds() / 60 > 150:
            mask[i] = True
    return mask


def session_aware_pnl(
    pos: np.ndarray,
    bars: list[dict],
    cost: float,
) -> np.ndarray:
    """时段感知 pnl：匹配实盘日内强平口径（分钟周期）。

    边界 bar：收益 = (close-open)/open（开盘进场）、换手 = |pos|（从
    空仓重进）；其余 bar 与收盘口径一致（close→close、|Δpos|）。
    """
    close = np.array([float(b.get("close") or 0) for b in bars], dtype=float)
    open_ = np.array([float(b.get("open") or 0) for b in bars], dtype=float)
    mask = session_open_mask(bars)
    ret = next_ret(close)
    ret_sa = ret.copy()
    ok = mask & (open_ > 0)
    ret_sa[ok] = (close[ok] - open_[ok]) / open_[ok]
    prev = np.roll(pos, 1)
    prev[0] = 0.0
    turnover = np.abs(pos - prev)
    turnover[mask] = np.abs(pos[mask])  # 边界从空仓重进
    return pos * ret_sa - turnover * cost


def session_aware_metrics(
    factor: np.ndarray,
    bars: list[dict],
    cost: float,
    periods: int,
) -> dict[str, float]:
    """时段感知指标（报告用）：与实盘 session_close 口径对齐"""
    pos = position_from_factor(factor)
    pnl = session_aware_pnl(pos, bars, cost)
    return {
        "session_sortino": _sortino(pnl, periods),
        "session_ann_ret": float(pnl.mean() * periods),
    }


def next_ret_open(opens: np.ndarray) -> np.ndarray:
    """实盘撮合口径收益率：pos[t] 在 open[t+1] 进场、open[t+2] 退场。

    因子信号在 bar t 收盘后产生，实盘市价单在下一根开盘附近成交；
    持仓到下一次信号变化（t+1 收盘后 → open[t+2] 离场）。
    ret_open[t] = (open[t+2] - open[t+1]) / open[t+1]，最后两根为 0。
    与 next_ret（close[t]→close[t+1]）的差异 = close→open 缺口漂移，
    换手越频繁该系统性偏差累积越大。
    """
    o = np.asarray(opens, dtype=float)
    ret = np.zeros_like(o)
    if len(o) > 2:
        entry = o[1:-1]
        exit_ = o[2:]
        ret[:-2] = (exit_ - entry) / np.maximum(np.abs(entry), 1e-9)
    return ret


def live_fill_metrics(
    factor: np.ndarray,
    opens: np.ndarray,
    cost: float,
    periods: int,
) -> dict[str, float]:
    """实盘口径指标（次根开盘成交）：仓位与收盘口径一致，仅收益基准不同。

    用于量化"模拟（收盘成交）vs 实盘（次根开盘成交）"的口径差，
    不进 GA 热路径（适应度仍按收盘口径），仅在冠军筛选/报告层调用。
    """
    pos = position_from_factor(factor)
    ret = next_ret_open(opens)
    prev = np.roll(pos, 1)
    prev[0] = 0.0
    turnover = np.abs(pos - prev)
    pnl = pos * ret - turnover * cost
    return {
        "live_fill_ann_ret": float(pnl.mean() * periods),
        "live_fill_sortino": _sortino(pnl, periods),
    }


def _sortino(pnl: np.ndarray, periods: int) -> float:
    if len(pnl) < 2:
        return 0.0
    mean = pnl.mean()
    dn = pnl[pnl < 0]
    if len(dn) == 0:
        return 20.0 if mean > 0 else 0.0
    dstd = float(np.sqrt((dn ** 2).mean()))
    if dstd < 1e-9:
        return 0.0
    return max(-20.0, min(20.0, mean / dstd * math.sqrt(periods)))


def _calmar(pnl: np.ndarray, periods: int) -> float:
    if len(pnl) == 0:
        return 0.0
    # P2-19:基线含 0 起点——序列一开始就下跌时,回撤应从 0(期初)起算,
    # 原 peak 从 cum[0] 起算会低估最大回撤
    cum = np.concatenate([[0.0], np.cumsum(pnl)])
    peak = np.maximum.accumulate(cum)
    dd = float((peak - cum).max())
    ann = pnl.mean() * periods
    if dd < 1e-9:
        return 10.0 if cum[-1] > 0 else 0.0
    return max(-10.0, min(10.0, ann / dd))


def _ts_ic(factor: np.ndarray, ret: np.ndarray) -> float:
    """因子与下根收益的时序相关

    ret 由 next_ret 传入,ret[t] 已是 t→t+1 的前向收益,与 factor[t] 直接
    对齐。(P0-3 修复:原实现取 ret[1:n+1],度量的是 t+1→t+2,整体错位一根;
    该项在 composite 中权重 0.20,与同函数 pnl 的 t 对 t 口径自相矛盾。)
    """
    n = min(len(factor) - 1, len(ret) - 1)
    if n < 10:
        return 0.0
    x = factor[:n]
    y = ret[:n]
    xm = x - x.mean()
    ym = y - y.mean()
    sx = float(xm.std())
    sy = float(ym.std())
    if sx < 1e-6 or sy < 1e-6:
        return 0.0
    return float((xm * ym).mean() / (sx * sy))


def _fwd_ret(close: np.ndarray, h: int) -> np.ndarray:
    """未来 h 根累计收益率（因果：t 时刻只知道 close[t]，fwd[t] 用 t+1..t+h）"""
    close = np.asarray(close, dtype=float)
    out = np.zeros_like(close)
    if 0 < h < len(close):
        out[:-h] = (close[h:] - close[:-h]) / np.maximum(np.abs(close[:-h]), 1e-9)
    return out


def _ts_ic_h(factor: np.ndarray, close: np.ndarray, h: int) -> float:
    """因子与未来 h 根累计收益的时序相关（h 周期 IC）

    单周期 IC（h=1）会放行"只在下一根有效"的因子——它们靠一根 bar 的
    微结构噪声刷 IC，持仓数根后信号衰减为零。多周期 IC 强制因子在
    1/5/20 根上都有预测力，与实际持仓期匹配。
    """
    fwd = _fwd_ret(close, h)
    n = min(len(factor) - h, len(fwd) - h)
    if n < 10:
        return 0.0
    x = factor[:n]
    y = fwd[:n]  # fwd[t] 已含 t+1..t+h，直接与 factor[t] 对齐
    xm = x - x.mean()
    ym = y - y.mean()
    sx = float(xm.std())
    sy = float(ym.std())
    if sx < 1e-6 or sy < 1e-6:
        return 0.0
    return float((xm * ym).mean() / (sx * sy))


def _symmetry(pos: np.ndarray) -> float:
    lr = float((pos > 0).mean())
    sr = float((pos < 0).mean())
    dev = abs(lr - 0.5) + abs(sr - 0.5)
    return max(-1.0, 1.0 - 2.0 * dev)


def _turnover_quality(pos: np.ndarray) -> float:
    """换手退化守卫（不是换手惩罚）

    换手的经济代价已在 pnl 里以 turnover*cost 扣除，此处不再重复计费，
    只识别两类退化：从不开仓（无效因子）、平均每根 bar 反手（纯噪声）。

    原实现 `1 - turnover*5` 会把平均换手 0.4 以上一律压到 -1，
    而 1m/5m 短线因子换手天然在 0.3~0.8 —— 等于系统性淘汰短线因子。
    """
    prev = np.roll(pos, 1)
    prev[0] = 0.0
    to = float(np.abs(pos - prev).mean())
    if to < 1e-6:
        return -1.0
    if to <= MAX_SANE_TURNOVER:
        return 0.0
    return max(-1.0, -(to - MAX_SANE_TURNOVER))


# ── 短线 fitness(shortline_v1;方案 B §4,冻结系数见实现决策文档 §4)──
# 模块级开关:search()/factor_local 入口按 profile 设置并复位(单线程内核
# 上下文;native 路径不经过本函数,由 metrics_ti 的构造参数同口径实现)。
_SHORTLINE_FITNESS = False


def set_shortline_fitness(enabled: bool) -> None:
    global _SHORTLINE_FITNESS
    _SHORTLINE_FITNESS = bool(enabled)


def shortline_penalty(avg_turnover: float, flip_rate: float, half_life: float) -> float:
    """composite 乘子(冻结):max(0, 1 − 0.5·min(turn/0.35,1) − 0.3·min(flip/0.08,1) − 0.2·max(0,1−hl/48))"""
    return max(
        0.0,
        1.0
        - 0.5 * min(avg_turnover / 0.35, 1.0)
        - 0.3 * min(flip_rate / 0.08, 1.0)
        - 0.2 * max(0.0, 1.0 - half_life / 48.0),
    )


def _flip_and_half_life(pos: np.ndarray) -> tuple[float, float]:
    """仓位序列的符号翻转率与 lag-1 自相关半衰期(冻结口径)。

    flip_rate = #{t≥1: pos_t·pos_{t-1}<0} / max(N-1,1)
    half_life: rho = c1/max(c0,1e-12)(中心化 lag-1 自相关),
    a=clip(|rho|,1e-9,0.9999999), hl = min(ln2/(−ln a), 500)
    """
    n = len(pos)
    if n < 2:
        return 0.0, 0.0
    prod = pos[1:] * pos[:-1]
    flips = float(np.count_nonzero(prod < 0))
    flip_rate = flips / max(n - 1, 1)
    m = float(pos.mean())
    d = pos - m
    c0 = float(np.mean(d * d))
    c1 = float(np.mean(d[1:] * d[:-1]))
    rho = c1 / max(c0, 1e-12)
    # 只认正持久性:rho<=0(含交替翻转)→ a 下限 → hl≈0.03(最快衰减)
    a = min(max(rho, 1e-9), 0.9999999)
    half_life = min(math.log(2.0) / (-math.log(a)), 500.0)
    return flip_rate, half_life


def evaluate_factor(
    factor: np.ndarray,
    close: np.ndarray,
    cost: float,
    periods: int,
) -> dict[str, Any]:
    """评估单个因子，返回指标 dict（含 composite 综合分）

    cost: 单位 turnover 的成本率（见 cost.turnover_cost_rate）
    periods: 该周期每年 bar 数（见 periods.bars_per_year）
    """
    factor = np.asarray(factor, dtype=float)
    close = np.asarray(close, dtype=float)
    pos = position_from_factor(factor)
    ret = next_ret(close)
    prev = np.roll(pos, 1)
    prev[0] = 0.0
    turnover = np.abs(pos - prev)
    pnl = pos * ret - turnover * cost

    ann = float(pnl.mean() * periods)
    sor = _sortino(pnl, periods)
    cal = _calmar(pnl, periods)
    ic = _ts_ic(factor, ret)
    # 多周期 IC 仅作报告指标（ts_ic_5/20）：E3 实验（见 docs/experiments/
    # factor-improvements-RESULTS.md P3 节）显示把它放进 composite 会让
    # 测试段 sortino 中位 3/4 目标退化——适应度保持 h=1 口径不变。
    ic5 = _ts_ic_h(factor, close, 5)
    ic20 = _ts_ic_h(factor, close, 20)
    sym = _symmetry(pos)
    tq = _turnover_quality(pos)

    # OOS 门控（后 25%）——硬淘汰:样本外为负直接乘 0 归零平台。
    # P1-4(改加性罚分)经拍板不采纳,两端一致保持现状;守护测试
    # test_oos_zero_platform 锁定"负样本外 → composite 恒 0.0"的裁定。
    n = len(pnl)
    oos_n = max(1, n // 4)
    oos_pnl = pnl[-oos_n:]
    oos_sor = _sortino(oos_pnl, periods)
    oos_negative = oos_sor <= 0
    if oos_negative:
        oos_mult = 0.0
    else:
        oos_mult = min(1.2, 1.0 + oos_sor * 0.1)

    # 半段一致性
    half = n // 2
    s1 = _sortino(pnl[:half], periods) if half > 1 else 0.0
    s2 = _sortino(pnl[half:], periods) if n - half > 1 else 0.0
    if s1 > 0 and s2 > 0:
        consist = 0.5
    elif s1 * s2 < 0:
        consist = -1.0
    else:
        consist = 0.0

    # 权重调整：年化 0.50→0.30（年化高不代表预测强，最易被噪声因子刷高），
    # IC 0.10→0.20（IC 是因子对下根收益的直接预测力，比年化更难造假），
    # consistency 0.05→0.10（前后半段同号，抑制单段过拟合）。
    # ann 项截断 ±1.0：年化无界而其余各项 O(1)，分钟线 periods≈8.4 万时
    # pnl.mean() 的微小噪声被放大成"年化 200%"，0.30*ann 会主导适应度、
    # 把选择压力集中到噪声上。截断后超 ±100% 的部分不再加分，排序在
    # 合理区间内保持单调。metrics 里仍上报未截断的原始 ann。
    ann_term = max(-1.0, min(1.0, ann))
    # OOS 硬淘汰口径:样本外为负 → composite 归零平台(×0.0)。
    # P1-4(加性罚分)曾改为压入负分区,经项目负责人拍板**不采纳**,与服务端
    # 保持一致(服务端台账实验 E-Z1 + test_oos_zero_platform 守护该结论):
    # 零平台的取舍是"并列 0 交给去重排序的稳定性"换"实现极简、行为可预期",
    # 排序倒挂问题留待后续实验重议,不属于本批口径。
    composite = (
        0.30 * ann_term
        + 0.15 * sor
        + 0.10 * cal
        + 0.20 * ic
        + 0.05 * sym
        + 0.05 * tq
        + 0.10 * consist
    ) * oos_mult

    avg_turnover = float(turnover.mean())
    flip_rate, half_life = _flip_and_half_life(pos)
    if _SHORTLINE_FITNESS:
        composite = composite * shortline_penalty(avg_turnover, flip_rate, half_life)

    return {
        "ann_ret": ann,
        "sortino": sor,
        "calmar": cal,
        "ts_ic": ic,
        "ts_ic_5": ic5,
        "ts_ic_20": ic20,
        "symmetry": sym,
        "turnover_q": tq,
        "oos_sortino": oos_sor,
        "oos_mult": oos_mult,
        "oos_negative": bool(oos_negative),
        "consistency": consist,
        "composite": composite,
        "avg_turnover": avg_turnover,
        "flip_rate": flip_rate,
        "half_life": half_life,
        "exposure": float(np.abs(pos).mean()),
        # 年化基数随周期变化，回传便于核对口径
        "periods": float(periods),
    }
