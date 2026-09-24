"""Walk-forward 与 train/test 切分 —— 防过拟合的纯函数工具

背景：原 search() 在整段 bars 上同时训练与评估，遗传规划能"看到"未来，
所谓 OOS 门控只是后 25% 的乘性折扣，搜索仍可反向拟合该段，属于假 OOS。
本模块把数据真正切成"训练时点之前 / 之后"，搜索只看训练段，
候选因子在测试段上的表现作为独立验证，从而暴露过拟合。

设计要点：
- 切分安全性：feature_matrix 的 zscore 窗口是因果的（features.zscore_window
  只用历史），所以对 train/test 子段分别调用 feature_matrix 不会泄露未来。
- 口径一致：复用 evaluate.py 的 _sortino/_calmar/_ts_ic/position_from_factor，
  保证与遗传搜索的评估同源，测试段指标与训练段可比。
- 纯指标：本模块返回 ann_ret/sortino/calmar/ts_ic 等原始指标，**不算 composite**，
  避免在测试段上再造一个"测试 composite"被反向拟合。
"""

from __future__ import annotations

from collections import OrderedDict
from typing import Any

import numpy as np

from ..features import bars_signature, feature_matrix
from ..vm import execute
from .evaluate import (
    _calmar,
    _sortino,
    _ts_ic,
    next_ret,
    next_ret_open,
    position_from_factor,
    position_live_discrete,
    session_aware_metrics,
)
from .periods import bars_per_year

# 测试段最小 bar 数：少于此值算出的 sortino/calmar 无统计意义，
# 直接判负，避免极短测试段给出虚假"通过"。
# P1-7:30 → 120(30~200 根的段几乎全是预热/噪声,而它是严格筛的核心判据;
# 分钟线数据上限 30-90 天,按"120 交易日"折算会使分钟测试段永远不足,
# 反而退化为无验证——统一取 120 根 bar 的统计下限,见 openspec 说明)
MIN_TEST_BARS = 120

# P1-7:分段评估的前置 warmup 根数(≥ 最长算子窗 60 与 zscore 窗 ≥200)
WARMUP_BARS = 250

# ── 段级结果缓存 ────────────────────────────────────────────
# 严格筛与 _enrich 对同一 (tokens, 段) 重复求值；walk-forward 每折的
# train/test 子段在候选间也完全相同。按 (tokens, 段签名, cost) 缓存
# 评估结果，命中即免掉 feature_matrix+execute+evaluate 的重复计算。
# 段签名复用 features.bars_signature（同一段必同签名）。
# 注意本缓存键含 tokens，拦不住「不同候选、同一段」的 feature_matrix
# 重算——那层由 features 的矩阵缓存负责，两者互补。
_SEG_CACHE: OrderedDict[tuple, Any] = OrderedDict()
# 256 → 2048:本地增强遴选(selection_v2)每代严格筛 ~30 个不同候选 ×
# (测试段×2 成本 + WF 各折 + 实盘口径),256 条会跨代抖动失效。条目是十几个
# 浮点的小 dict,容量只影响命中率,不影响任何数值。
_SEG_CACHE_MAX = 2048


def _cache_get(key: tuple) -> Any:
    hit = _SEG_CACHE.get(key)
    if hit is not None:
        _SEG_CACHE.move_to_end(key)
    return hit


def _cache_put(key: tuple, value: Any) -> None:
    _SEG_CACHE[key] = value
    _SEG_CACHE.move_to_end(key)
    while len(_SEG_CACHE) > _SEG_CACHE_MAX:
        _SEG_CACHE.popitem(last=False)


def clear_segment_cache() -> None:
    """清空段缓存（测试隔离用）"""
    _SEG_CACHE.clear()


def split_bars(
    bars: list[dict[str, Any]],
    train_ratio: float,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """把 bars 按 train_ratio 切成 (train_bars, test_bars)

    train_ratio ∈ (0,1)，为 0 时返回 (bars, []) 表示不切分（向后兼容）。
    test_bars 至少留 1 根；train_bars 至少留 MIN_TEST_BARS 以保证可训练。
    """
    if train_ratio <= 0.0:
        return list(bars), []
    n = len(bars)
    cut = int(round(n * max(0.05, min(0.95, train_ratio))))
    # 边界保护：任一段过短都退化为不切分
    if cut < MIN_TEST_BARS or n - cut < MIN_TEST_BARS:
        return list(bars), []
    return list(bars[:cut]), list(bars[cut:])


def evaluate_on_slice(
    tokens: list[int],
    all_bars: list[dict[str, Any]],
    lo: int,
    hi: int,
    timeframe: str,
    cost: float,
) -> dict[str, float] | None:
    """带前置 warmup 的切片评估(P1-7):用 all_bars[lo-w:hi] 计算特征与
    因子,丢弃前 w 根只在 [lo,hi) 上算指标。

    此前对 train/test 子段分别独立调用 feature_matrix:不泄露未来,但
    **会丢失过去**——段首约 200 根处于 zscore/长窗算子的预热区,数值分布
    与连续运行完全不同,短测试段的 sortino 基本是噪声。带 warmup 上下文
    后段首指标与全量连续计算一致。因子无效或切片过短返回 None。
    结果按 (tokens, 上下文签名, timeframe, cost) 缓存。
    """
    n = hi - lo
    if n < MIN_TEST_BARS:
        return None
    w = min(lo, WARMUP_BARS)
    ctx = all_bars[lo - w : hi]
    key = (
        tuple(int(t) for t in tokens),
        bars_signature(ctx),
        timeframe,
        round(float(cost), 10),
    )
    cached = _cache_get(key)
    if cached is not None:
        return dict(cached) if cached != "__none__" else None
    mat = feature_matrix(ctx)
    factor = execute(tokens, mat)
    if factor is None:
        _cache_put(key, "__none__")
        return None
    factor = factor[w:]
    bars = ctx[w:]
    close = np.array([float(b.get("close") or 0) for b in bars], dtype=float)
    periods = bars_per_year(bars, timeframe)
    pos = position_from_factor(factor)
    ret = next_ret(close)
    prev = np.roll(pos, 1)
    prev[0] = 0.0
    turnover = np.abs(pos - prev)
    pnl = pos * ret - turnover * cost
    # 实盘撮合口径（次根开盘成交）：同一仓位、开盘对开盘收益基准，
    # 用于量化收盘口径与实际成交价之间的缺口漂移
    opens = np.array([float(b.get("open") or 0) for b in bars], dtype=float)
    pnl_open = pos * next_ret_open(opens) - turnover * cost
    # 时段感知口径（分钟周期，匹配实盘日内强平）：边界 bar 开盘进场，
    # 不计隔夜跳空——报告用，量化"回测持有隔夜 vs 实盘日内平仓"的差
    ses = session_aware_metrics(factor, bars, cost, periods)
    out = {
        "ann_ret": float(pnl.mean() * periods),
        "sortino": float(_sortino(pnl, periods)),
        "calmar": float(_calmar(pnl, periods)),
        "ts_ic": float(_ts_ic(factor, ret)),
        "avg_turnover": float(turnover.mean()),
        "exposure": float(np.abs(pos).mean()),
        "live_fill_ann_ret": float(pnl_open.mean() * periods),
        "live_fill_sortino": float(_sortino(pnl_open, periods)),
        "session_ann_ret": ses["session_ann_ret"],
        "session_sortino": ses["session_sortino"],
        "bars": float(len(bars)),
    }
    _cache_put(key, out)
    return dict(out)


def live_discrete_on_slice(
    tokens: list[int],
    all_bars: list[dict[str, Any]],
    lo: int,
    hi: int,
    timeframe: str,
    cost: float,
    entry: float,
) -> dict[str, float] | None:
    """实盘离散口径切片评估(本地增强):±1 手、|仓位|>entry 开仓、<0.05 平仓。

    与 evaluate_on_slice 同样带 warmup 上下文;迟滞状态机在 warmup 段就开始
    推进,段首持仓状态与连续运行一致(而非从空仓硬启动)。
    """
    n = hi - lo
    if n < MIN_TEST_BARS:
        return None
    w = min(lo, WARMUP_BARS)
    ctx = all_bars[lo - w : hi]
    key = (
        "live_discrete",
        tuple(int(t) for t in tokens),
        bars_signature(ctx),
        timeframe,
        round(float(cost), 10),
        round(float(entry), 6),
    )
    cached = _cache_get(key)
    if cached is not None:
        return dict(cached) if cached != "__none__" else None
    factor = execute(tokens, feature_matrix(ctx))
    if factor is None:
        _cache_put(key, "__none__")
        return None
    pos_full = position_live_discrete(factor, entry=entry)
    prev_full = np.roll(pos_full, 1)
    prev_full[0] = 0.0
    pos = pos_full[w:]
    turnover = np.abs(pos - prev_full[w:])
    bars = ctx[w:]
    close = np.array([float(b.get("close") or 0) for b in bars], dtype=float)
    periods = bars_per_year(bars, timeframe)
    pnl = pos * next_ret(close) - turnover * cost
    out = {
        "ann_ret": float(pnl.mean() * periods),
        "sortino": float(_sortino(pnl, periods)),
        "n_trades": float(np.sum((pos != 0) & (pos != prev_full[w:]))),
        "exposure": float(np.abs(pos).mean()),
    }
    _cache_put(key, out)
    return dict(out)


def evaluate_on_segment(
    tokens: list[int],
    bars: list[dict[str, Any]],
    timeframe: str,
    cost: float,
) -> dict[str, float] | None:
    """在任意 bars 子段上执行因子并返回纯指标(兼容包装)。

    新代码请用 evaluate_on_slice(带 warmup 上下文);本函数保留给
    只有子段数据的调用方(cross_symbol/decay 等历史路径)。
    """
    return evaluate_on_slice(tokens, bars, 0, len(bars), timeframe, cost)


def walk_forward_eval(
    tokens: list[int],
    bars: list[dict[str, Any]],
    timeframe: str,
    cost: float,
    n_folds: int,
    train_len: int | None = None,
) -> dict[str, Any] | None:
    """滚动 walk-forward：依次在多个"过去→未来"窗口验证因子稳健性

    切法：把 bars 等分 n_folds+1 段，第 i 折（i=1..n_folds）用前 i 段作训练、
    第 i+1 段作测试。等距切窗保证每折测试段互不重叠，覆盖不同市场环境。

    train_len(P1-8 折中版)：遗传搜索传入的 bars 通常是含训练段的全量数据,
    前几折的"测试段"实际落在训练段内——见过数据上的"通过"不构成样本外
    证据。传入训练段长度后,每折标记 in_train(test_end ≤ train_len),
    wf_stable 只对 in_train=False 的折生效(无样本外折时恒真,由调用方
    依据 n_oos_folds 自行展示);None = 不区分(报告路径的旧行为)。

    稳健性判据（wf_stable）：(样本外)折的测试段 sortino > 0 才算稳定。
    返回 None 表示因子无法执行或窗口不足；返回 dict 含 folds 明细与汇总。
    """
    if n_folds <= 0:
        return None
    n = len(bars)
    # 每段至少 MIN_TEST_BARS，否则折叠数过多导致每段无统计意义
    seg = n // (n_folds + 1)
    if seg < MIN_TEST_BARS:
        return None

    folds: list[dict[str, Any]] = []
    test_sortinos: list[float] = []
    test_anns: list[float] = []
    oos_sortinos: list[float] = []
    oos_anns: list[float] = []
    for i in range(1, n_folds + 1):
        train_end = i * seg
        test_start = train_end
        # 最后一折的测试段吃到尾部，避免余数被丢弃
        test_end = (i + 1) * seg if i < n_folds else n
        in_train = bool(train_len is not None and test_end <= train_len)
        train_m = evaluate_on_slice(tokens, bars, 0, train_end, timeframe, cost)
        test_m = evaluate_on_slice(tokens, bars, test_start, test_end, timeframe, cost)
        if train_m is None or test_m is None:
            return None
        folds.append({"train": train_m, "test": test_m, "in_train": in_train})
        test_sortinos.append(test_m["sortino"])
        test_anns.append(test_m["ann_ret"])
        if not in_train:
            oos_sortinos.append(test_m["sortino"])
            oos_anns.append(test_m["ann_ret"])

    wf_stable = all(s > 0.0 for s in oos_sortinos)
    # 跨折一致性：测试年化的变异系数（std/|mean|），越小越稳；均值近 0 时退化
    # (样本外折存在时按样本外折计算,否则按全部折——报告口径尽量有数)
    stat_src = oos_anns if oos_anns else test_anns
    mean_ann = float(np.mean(stat_src))
    std_ann = float(np.std(stat_src))
    wf_consistency = 1.0 - std_ann / (abs(mean_ann) + 1e-9) if mean_ann != 0 else 0.0
    return {
        "folds": folds,
        "wf_stable": bool(wf_stable),
        "wf_mean_test_sortino": float(np.mean(oos_sortinos if oos_sortinos else test_sortinos)),
        "wf_mean_test_ann": mean_ann,
        "wf_consistency": float(wf_consistency),
        "n_folds": int(n_folds),
        "n_oos_folds": len(oos_sortinos),
    }
