"""遗传规划因子搜索 —— 树个体 + 锦标赛 + 精英 + 交叉/变异

个体为语法树（嵌套 list）：
  叶子：["feat", idx]
  内部：["op", op_idx, child1, child2, ...]
序列化为后缀 token 序列后交 StackVM 执行。
无外部依赖，纯 numpy + random。
"""

from __future__ import annotations

import gc
import math
import random
import sys
from collections import OrderedDict
from dataclasses import dataclass
from typing import Any

import numpy as np

from .express import to_text
from .features import bars_signature, feature_matrix, active_feature_ids
from .ops import OPS_CONFIG
from .scoring.evaluate import evaluate_factor, next_ret, position_from_factor
from .scoring.periods import bars_per_year
from .scoring.split_plan import SplitPlan, build_split_plan
from .scoring.walk_forward import (
    WARMUP_BARS,
    evaluate_on_slice,
    MIN_TEST_BARS,
    evaluate_on_segment,
    live_discrete_on_slice,
    split_bars,
    walk_forward_eval,
    walk_forward_eval_v2,
)
from .vm import FEAT_COUNT, FEAT_OFFSET, execute, execute_for_bars, is_constant, validate


@dataclass
class SearchConfig:
    """搜索参数

    seed_tokens: 再进化种子（token 列表的列表）；None 表示无种子。
    禁止可变默认参数，入口处归一化为 list。
    cost: 单位 turnover 成本率。生产路径由 API 按品种推导后显式传入
    （见 api/factor_lab/common.py:resolve_cost），此处 0.0003 仅为
    直接调用内核时的保守兜底，不代表期货真实成本（缺 tick 滑点）。

    防过拟合参数（默认全 0 = 关闭，行为与改造前一致，完全向后兼容）：
    - train_ratio: 把 bars 按 ratio 切分，遗传搜索只在训练段进行，
      测试段作独立验证。设为 0 不切分。
    - test_recent_bars: 强制最近 N 根 bars 作为测试段（方案 E，专治"近期
      失效"）。优先级高于 train_ratio：非 0 时按尾部 N 根切，覆盖 train_ratio。
    - walk_forward_folds: 搜索后对候选因子跑 N 折滚动 walk-forward，
      任一折测试段为负的因子被淘汰。0 = 关闭。
    """
    crypto_profile: bool = False
    population: int = 40
    generations: int = 20
    max_depth: int = 4
    top_n: int = 10
    crossover_p: float = 0.6
    mutation_p: float = 0.3
    seed: int = 42
    cost: float = 0.0003
    seed_tokens: list[list[int]] | None = None
    train_ratio: float = 0.0
    test_recent_bars: int = 0
    walk_forward_folds: int = 0
    # 实盘口径门：严格筛额外要求测试段"次根开盘成交"口径 sortino>0。
    # 收盘撮合与实盘成交价之间的缺口漂移随换手累积，高换手因子可能
    # 收盘口径为正、开盘口径为负（模拟赚钱实盘亏）。默认关，由实验定去留。
    live_fill_gate: bool = False
    # 跨品种验证：严格筛要求 ≥⌈K/2⌉ 个同板块伙伴品种 sortino>0。
    # 伙伴 bars 由异步调用方（API/挖掘 loop）预加载注入（热路径无 IO）。
    # None/空 = 跳过该门。默认关。
    cross_peers: list[tuple[str, list[dict[str, Any]]]] | None = None
    # 岛模型：种群分 N 岛独立进化（总评估次数不变，岛内种群相应缩小），
    # 每 5 代各岛 top-2 环状迁移到下一岛。维持演化多样性，防种群整体
    # 收敛到同一因子区域。1 = 关闭（默认，行为与单岛完全一致）。
    islands: int = 1
    # ── 桌面端本地增强(默认全关 = 与服务端内核逐位一致)────────────
    # selection_v2:冠军遴选增强。
    #   (1) 先按行为去重(train 段因子序列 |corr|>0.9 视为同一因子)再进严格筛,
    #       严格筛看到的是 ~30 个不同想法,而非同一因子的一堆变体;
    #   (2) 测试段对半切出"封存段":严格筛/WF/跨品种只用前半(验证段),封存段
    #       只在最终冠军上评估一次写入 holdout_metrics,不参与任何筛选;
    #   (3) 报告 Deflated Sharpe(dsr,按试验次数折扣的显著性概率)。
    selection_v2: bool = False
    # evolve_v2:进化增强——点变异/收缩变异、行为克隆降权、OOS 零平台细分、
    # 停滞重启。只影响种群繁殖,对外指标仍全部出自 evaluate_factor。
    evolve_v2: bool = False
    # 实盘离散口径门:>0 时严格筛要求验证段按 ±1 手、该开仓阈值执行 sortino>0
    # (连续 tanh 仓位与实盘"超阈值才开仓"不一致,弱信号因子模拟赚钱实盘不开仓)
    live_entry_gate: float = 0.0
    # ── crypto_local_v2 研究契约(方案 §3/§5;空 = 旧路径逐位不变)─────
    # research_profile: "crypto_local_v2" 启用显式切分计划(60/20/20)、
    #   严格因果归一化、验证折只在验证区内、样本不足显式标记;
    #   未知版本号在 factor_local 入口被拒绝,不静默走旧执行器。
    research_profile: str = ""
    # execution_model: signal_research | spot_long_flat | perp_next_open
    #   (执行收益/资金费用在 scoring/execution.py;此处随结果冻结)
    execution_model: str = "signal_research"
    # label_span: 收益标签跨越的 bar 数(末尾不足的不补 0 参加统计)
    label_span: int = 1
    # joint_training(本地增强):cross_peers 伙伴币种同时参与训练适应度
    # (主币种 + 伙伴训练窗 composite 的 均值−0.5·标准差),伙伴验证改为只在
    # 主币种训练段之后的时间窗上计分。需 cross_peers 非空,否则无效果。
    joint_training: bool = False


@dataclass
class Champion:
    """冠军因子"""
    tokens: list[int]
    text: str
    metrics: dict[str, Any]
    composite: float


def is_v2_config(cfg: SearchConfig) -> bool:
    """cfg 是否处于 crypto_local_v2 研究契约"""
    return cfg.research_profile == "crypto_local_v2"


def _v2_head_trim(mat: np.ndarray, active_ids: list[int]) -> int:
    """v2:直连特征头部未采样前缀的最大长度(共享计分日历的统一裁剪)。

    头部缺失经 nan_to_num 参与算子统计会冒充 0;统一从 trim 起计分,
    所有候选(无论是否用到晚启动特征)在同一日历上比较(方案 5.2-6)。
    仅统计留在 active 集的特征(超限特征已被 active_feature_ids 排除)。
    """
    trim = 0
    for i in active_ids:
        if i < 52:
            continue
        row = mat[i]
        finite = np.isfinite(row)
        if finite.all() or not finite.any():
            continue
        trim = max(trim, int(np.argmax(finite)))
    return trim


# Pyodide（桌面端本地引擎）无紧凑 GC，代际回收缓解 numpy 碎片堆积。
# CPython 上它不是"无害"的：特征矩阵按段缓存后单次搜索只剩 ~0.8s 计算，
# 每代一次 gc.collect() 实测占 search() 总耗时 67%（1.7s / 2.5s）。
# 按平台门控——Pyodide 行为完全不变，服务端省掉这笔纯开销。
# 数值结果与 gc 无关，两个平台仍逐位一致。
_IS_PYODIDE = sys.platform == "emscripten"


def _collect_between_generations() -> None:
    """代际回收（仅 Pyodide 生效）"""
    if _IS_PYODIDE:
        gc.collect()


# ── 树操作 ──────────────────────────────────────────────────


def _clone(tree: list) -> list:
    if tree[0] == "feat":
        return ["feat", tree[1]]
    return ["op", tree[1]] + [_clone(c) for c in tree[2:]]


def _draw_feature(rng: random.Random, feat_n: int) -> int:
    pool = getattr(rng, "_active_features", None)
    return rng.choice(pool) if pool else rng.randrange(feat_n)


def _search_space(mat, cfg, rng):
    crypto = cfg.crypto_profile or is_v2_config(cfg)
    active = active_feature_ids(
        mat, crypto,
        max_head_gap=WARMUP_BARS if is_v2_config(cfg) else None,
    )
    if crypto:
        # Modest prior for new information, not calendar overfitting.
        rng._active_features = active + [i for i in active if i >= 45]
    for seed in cfg.seed_tokens or []:
        if any(int(t) < FEAT_OFFSET and int(t) not in active for t in seed):
            raise ValueError("Seed depends on unavailable features for this training data/profile")
    limit = len(OPS_CONFIG) if crypto else 40
    return ([i for i, (_, _, a) in enumerate(OPS_CONFIG[:limit]) if a == 1],
            [i for i, (_, _, a) in enumerate(OPS_CONFIG[:limit]) if a == 2])


# 训练段分块稳健性(本地增强):训练段 K 等分,各块单独算 sortino。
# 加密行情牛熊/震荡切换快,整段 composite 高的因子常是"某一段行情吃满、
# 其余段亏"——这类因子验证/封存段基本必亏(冠军表测试年化/封存 Sortino 飘红
# 的主因)。只用训练段数据,不触碰验证/封存段。
ROBUST_BLOCKS = 4


def _block_robustness(
    factor: np.ndarray, close: np.ndarray, cost: float, periods: float
) -> tuple[float, float]:
    """返回 (正 sortino 块占比, 最差块 sortino);样本太短返回 (1.0, 0.0) 中性值"""
    from .scoring.evaluate import _sortino

    n = min(len(factor), len(close))
    if n < ROBUST_BLOCKS * 20:
        return 1.0, 0.0
    pos = position_from_factor(np.asarray(factor[:n], dtype=float))
    prev = np.roll(pos, 1)
    prev[0] = 0.0
    pnl = pos * next_ret(np.asarray(close[:n], dtype=float)) - np.abs(pos - prev) * cost
    q = n // ROBUST_BLOCKS
    sors = [
        _sortino(pnl[k * q : (k + 1) * q if k < ROBUST_BLOCKS - 1 else n], periods)
        for k in range(ROBUST_BLOCKS)
    ]
    return sum(1 for s in sors if s > 0) / ROBUST_BLOCKS, float(min(sors))


def _robust_key(comp: float, pos_frac: float, min_sor: float) -> float:
    """稳健排序键:正 composite 按正块占比打折(全块为正不打折,仅一块为正打到 ~0.44),
    再以最差块 sortino 微调;只影响排序/选择压力,不改 composite 本身"""
    key = comp * (0.25 + 0.75 * pos_frac) if comp > 0 else comp
    return key + 0.02 * math.tanh(min_sor)


def _training_evaluator(
    mat, close, cost, periods, trim: int = 0, bars: list | None = None, robust: bool = False
):
    # Only tokens/metrics are cached; no T-length series per candidate.
    # robust(evolve_v2):metrics 追加 block_pos_frac/block_min_sortino 供繁殖排序
    from functools import lru_cache
    @lru_cache(maxsize=20000)
    def cached(tokens):
        if validate(list(tokens)):
            return None, None, -999.0
        try:
            factor = (
                execute_for_bars(list(tokens), mat, bars)
                if bars is not None
                else execute(list(tokens), mat)
            )
            if factor is None or is_constant(factor[trim:] if trim else factor):
                return None, None, -999.0
            if trim:
                # v2 共享计分日历:头部未采样前缀不参与适应度
                metrics = evaluate_factor(factor[trim:], close[trim:], cost=cost, periods=periods)
            else:
                metrics = evaluate_factor(factor, close, cost=cost, periods=periods)
            if robust:
                pf, ms = _block_robustness(
                    factor[trim:] if trim else factor,
                    close[trim:] if trim else close,
                    cost, periods,
                )
                metrics["block_pos_frac"] = pf
                metrics["block_min_sortino"] = ms
        except (ValueError, FloatingPointError, OverflowError):
            return None, None, -999.0
        comp = float(metrics["composite"]) - 0.02 * max(0, len(tokens) - 12)
        return list(tokens), metrics, comp
    return cached


def _random_tree(
    depth: int,
    feat_n: int,
    op_one: list[int],
    op_two: list[int],
    rng: random.Random,
) -> list:
    """随机生成合法语法树"""
    if depth <= 0 or (depth < 3 and rng.random() < 0.4):
        return ["feat", _draw_feature(rng, feat_n)]
    if op_two and rng.random() < 0.3:
        op = rng.choice(op_two)
        return [
            "op",
            op,
            _random_tree(depth - 1, feat_n, op_one, op_two, rng),
            _random_tree(depth - 1, feat_n, op_one, op_two, rng),
        ]
    op = rng.choice(op_one)
    return ["op", op, _random_tree(depth - 1, feat_n, op_one, op_two, rng)]


def tree_to_tokens(tree: list) -> list[int]:
    """树 → 后缀 token 序列（vm 执行用）"""
    if tree[0] == "feat":
        return [int(tree[1])]
    tokens: list[int] = []
    for child in tree[2:]:
        tokens.extend(tree_to_tokens(child))
    tokens.append(int(tree[1]) + FEAT_OFFSET)
    return tokens


def tokens_to_tree(tokens: list[int]) -> list | None:
    """后缀 token 序列 → 语法树（tree_to_tokens 的逆；非法返回 None）"""
    stack: list[list] = []
    for t in tokens:
        t = int(t)
        if t < FEAT_OFFSET:
            if t < 0 or t >= FEAT_COUNT:
                return None
            stack.append(["feat", t])
            continue
        op = t - FEAT_OFFSET
        if op < 0 or op >= len(OPS_CONFIG):
            return None
        arity = OPS_CONFIG[op][2]
        if len(stack) < arity:
            return None
        if arity == 1:
            stack.append(["op", op, stack.pop()])
        elif arity == 2:
            b = stack.pop()
            a = stack.pop()
            stack.append(["op", op, a, b])
        else:
            children = [stack.pop() for _ in range(arity)][::-1]
            stack.append(["op", op, *children])
    return stack[0] if len(stack) == 1 else None


def _all_nodes(tree: list) -> list[list]:
    out = [tree]
    if tree[0] == "op":
        for child in tree[2:]:
            out.extend(_all_nodes(child))
    return out


def _replace_random(tree: list, donor: list, rng: random.Random) -> list:
    """在 tree 中随机位置替换为 donor 副本"""
    nodes = _all_nodes(tree)
    target = rng.choice(nodes)
    target[:] = _clone(donor)
    return tree


def _random_subtree(tree: list, rng: random.Random) -> list:
    return rng.choice(_all_nodes(tree))


def _mutate(
    tree: list,
    feat_n: int,
    op_one: list[int],
    op_two: list[int],
    rng: random.Random,
    max_depth: int,
) -> list:
    donor = _random_tree(rng.randrange(2, max_depth + 1), feat_n, op_one, op_two, rng)
    return _replace_random(tree, donor, rng)


def _crossover(mom: list, dad: list, rng: random.Random) -> list:
    child = _clone(mom)
    donor = _random_subtree(dad, rng)
    return _replace_random(child, donor, rng)


def _tournament(scored: list[tuple[float, list]], rng: random.Random, k: int = 3) -> list:
    sample = rng.sample(scored, min(k, len(scored)))
    return max(sample, key=lambda x: x[0])[1]


# ── 进化增强(evolve_v2,桌面端本地专属;关闭时以上原逻辑逐位不变)──────


def _op_family(name: str) -> str:
    """算子族:去掉窗口/阶数后缀(TS_MA_5 → TS_MA,DELTA_1 → DELTA)"""
    head, _, tail = name.rpartition("_")
    return head if head and tail.isdigit() else name


_OP_FAMILY: list[str] = [_op_family(name) for name, _, _ in OPS_CONFIG]

# 连续多少代最优键无提升视为停滞,停滞时用多少比例的随机新个体替换繁殖尾部
STAGNATION_GENS = 8
RESTART_FRACTION = 0.3


def _point_mutate(
    tree: list,
    feat_n: int,
    op_one: list[int],
    op_two: list[int],
    rng: random.Random,
) -> list:
    """点变异:随机节点换同元数算子(半数概率限同族,即换窗口)/换特征。

    子树替换对好公式破坏性太大;点变异做局部微调(TS_MA_10→TS_MA_20、
    RET5→RET20),在收敛期比整棵子树重掷有效得多。
    """
    node = rng.choice(_all_nodes(tree))
    if node[0] == "feat":
        node[1] = _draw_feature(rng, feat_n)
        return tree
    pool = op_one if len(node) == 3 else op_two
    cur = int(node[1])
    same = [o for o in pool if _OP_FAMILY[o] == _OP_FAMILY[cur] and o != cur]
    if same and rng.random() < 0.5:
        node[1] = rng.choice(same)
    elif pool:
        node[1] = rng.choice(pool)
    return tree


def _shrink_mutate(
    tree: list,
    feat_n: int,
    op_one: list[int],
    op_two: list[int],
    rng: random.Random,
) -> list:
    """收缩变异:随机算子节点被自身的某个后代替换(公式瘦身,对抗膨胀)"""
    ops = [n for n in _all_nodes(tree) if n[0] == "op"]
    if not ops:
        return _point_mutate(tree, feat_n, op_one, op_two, rng)
    target = rng.choice(ops)
    donor = _clone(rng.choice(_all_nodes(target)[1:]))
    target[:] = donor
    return tree


def _mutate_v2(
    tree: list,
    feat_n: int,
    op_one: list[int],
    op_two: list[int],
    rng: random.Random,
    max_depth: int,
) -> list:
    """变异算子混合:40% 子树替换(探索)/40% 点变异(微调)/20% 收缩(瘦身)"""
    r = rng.random()
    if r < 0.4:
        return _mutate(tree, feat_n, op_one, op_two, rng, max_depth)
    if r < 0.8:
        return _point_mutate(tree, feat_n, op_one, op_two, rng)
    return _shrink_mutate(tree, feat_n, op_one, op_two, rng)


def _metric_fingerprint(metrics: dict | None) -> tuple | None:
    """行为指纹:同训练段上年化/sortino/IC 完全相同 = 同一个因子(写法不同)"""
    if not metrics:
        return None
    try:
        return (
            round(float(metrics["ann_ret"]), 6),
            round(float(metrics["sortino"]), 6),
            round(float(metrics["ts_ic"]), 6),
        )
    except (KeyError, TypeError, ValueError):
        return None


def _rank_v2(
    scored: list[tuple[float, list, list[int] | None, dict | None]],
) -> list[tuple[float, list]]:
    """繁殖用排序键(不改 composite 本身,只影响选择压力):

    - OOS 零平台细分:样本外为负的候选 composite 被 ×0 压成并列 0,遗传选择在
      这片平台上没有方向;加 0.02·tanh(oos_sortino)(≤0)让"亏得少"的排前,
      给搜索一个指向样本外转正的梯度。0.02 小于任何正 composite 的量级。
    - 行为克隆降权:与已出现者指纹相同的个体键 -1,不再占精英/锦标赛名额,
      防止种群塌缩成同一因子的 N 种写法。
    scored 须已按 composite 降序(首次出现者即该指纹下最优)。
    """
    seen: set[tuple] = set()
    out: list[tuple[float, list]] = []
    for comp, tree, _tokens, metrics in scored:
        key = comp
        if metrics is not None:
            if "block_pos_frac" in metrics:
                # 分块稳健性:只在一段行情里赚钱的候选降低选择压力
                key = _robust_key(
                    key,
                    float(metrics["block_pos_frac"]),
                    float(metrics.get("block_min_sortino") or 0.0),
                )
            if metrics.get("oos_negative"):
                key += 0.02 * math.tanh(float(metrics.get("oos_sortino") or 0.0))
            fp = _metric_fingerprint(metrics)
            if fp is not None:
                if fp in seen:
                    key -= 1.0
                else:
                    seen.add(fp)
        out.append((key, tree))
    out.sort(key=lambda x: x[0], reverse=True)
    return out


def _breed_v2(
    ranked: list[tuple[float, list]],
    size: int,
    cfg: SearchConfig,
    rng: random.Random,
    feat_n: int,
    op_one: list[int],
    op_two: list[int],
    restart: bool,
) -> list:
    """evolve_v2 繁殖:精英 + 锦标赛 + 交叉/混合变异;停滞时尾部注入随机新个体"""
    elite_n = max(2, size // 10)
    new_pop = [_clone(t) for _, t in ranked[:elite_n]]
    n_fresh = int(size * RESTART_FRACTION) if restart else 0
    while len(new_pop) < size - n_fresh:
        mom = _tournament(ranked, rng)
        if rng.random() < cfg.crossover_p and len(ranked) > 1:
            child = _crossover(mom, _tournament(ranked, rng), rng)
        else:
            child = _clone(mom)
        if rng.random() < cfg.mutation_p:
            child = _mutate_v2(child, feat_n, op_one, op_two, rng, cfg.max_depth)
        new_pop.append(child)
    while len(new_pop) < size:
        new_pop.append(_random_tree(cfg.max_depth, feat_n, op_one, op_two, rng))
    return new_pop


class _Stagnation:
    """每岛最优排序键的停滞计数(evolve_v2 重启触发器)"""

    def __init__(self, n: int) -> None:
        self.best = [-math.inf] * n
        self.stall = [0] * n

    def update(self, isl: int, best_key: float) -> bool:
        """记录本代最优;返回本次繁殖是否应注入随机新个体(并清零计数)"""
        if best_key > self.best[isl] + 1e-9:
            self.best[isl] = best_key
            self.stall[isl] = 0
            return False
        self.stall[isl] += 1
        if self.stall[isl] >= STAGNATION_GENS:
            self.stall[isl] = 0
            return True
        return False


# ── 主搜索 ─────────────────────────────────────────────────


def search(
    bars: list[dict[str, Any]],
    timeframe: str,
    cfg: SearchConfig | None = None,
) -> list[Champion]:
    """对给定 K 线运行遗传规划，返回 top-N 冠军因子

    timeframe 为必填：年化基数由它推导（分钟周期与日线差 6~345 倍），
    沿用日线基数会让收益项在 composite 中失效。

    防过拟合：当 cfg.train_ratio>0 或 cfg.test_recent_bars>0 时，遗传搜索
    只在训练段进行，测试段作独立验证（搜索全程看不到测试段），并在最终
    排行时淘汰测试段 sortino≤0 的因子；walk_forward_folds>0 时再叠加滚动
    多窗口验证，淘汰任一折为负的因子。三个参数全 0 时退化为改造前行为。
    """
    cfg = cfg or SearchConfig()

    # ── 切分:v2 显式计划优先;test_recent_bars 优先于 train_ratio ────
    anti_overfit = (
        cfg.train_ratio > 0.0 or cfg.test_recent_bars > 0 or cfg.walk_forward_folds > 0
    )
    plan: SplitPlan | None = None
    v2 = is_v2_config(cfg)
    if v2:
        plan = build_split_plan(
            len(bars), label_span=cfg.label_span, warmup=WARMUP_BARS, bars=bars
        )
        if plan.sufficient:
            # 封存段 [validation_end, n) 对搜索全程不可见;验证段作严格筛 test
            bars = list(bars[: plan.validation_end])
            train_bars = list(bars[: plan.train_end])
            test_bars = list(bars[plan.train_end :])
            anti_overfit = True
        else:
            # 样本不足:允许明确探索(全量训练),但不得输出验证通过的标记
            train_bars, test_bars = list(bars), []
    elif cfg.test_recent_bars > 0:
        # 方案 E：尾部 N 根强制作测试段，专治"近期失效"
        cut = max(MIN_TEST_BARS, len(bars) - cfg.test_recent_bars)
        if cut < MIN_TEST_BARS or (len(bars) - cut) < MIN_TEST_BARS:
            train_bars, test_bars = list(bars), []
        else:
            train_bars, test_bars = list(bars[:cut]), list(bars[cut:])
    elif cfg.train_ratio > 0.0:
        train_bars, test_bars = split_bars(bars, cfg.train_ratio)
    else:
        train_bars, test_bars = list(bars), []
    use_test = bool(test_bars) and len(test_bars) >= MIN_TEST_BARS
    if v2:
        use_test = plan is not None and plan.sufficient

    # 遗传搜索全程只在 train_bars 上进行（消除"假 OOS"）
    feat_mat = feature_matrix(train_bars)
    close = np.array([float(b.get("close") or 0) for b in train_bars], dtype=float)
    periods = bars_per_year(train_bars, timeframe)
    feat_n = feat_mat.shape[0] if (cfg.crypto_profile or v2) else min(40, feat_mat.shape[0])
    rng = random.Random(cfg.seed)
    op_one, op_two = _search_space(feat_mat, cfg, rng)
    head_trim = _v2_head_trim(feat_mat, rng._active_features or []) if v2 else 0
    cached_eval = _training_evaluator(
        feat_mat, close, cfg.cost, periods, trim=head_trim, bars=train_bars if v2 else None,
        robust=cfg.evolve_v2,
    )
    if cfg.joint_training and cfg.cross_peers:
        from .joint_training import build_joint_context, wrap_evaluator

        cached_eval = wrap_evaluator(
            cached_eval,
            build_joint_context(cfg.cross_peers, train_bars, timeframe, v2),
            cfg.cost, v2,
        )
    seeds = list(cfg.seed_tokens or [])

    def eval_tree(tree: list):
        return cached_eval(tuple(tree_to_tokens(tree)))

    def eval_tokens(tokens: list[int]):
        return cached_eval(tuple(tokens))

    # 初始种群
    population = [
        _random_tree(cfg.max_depth, feat_n, op_one, op_two, rng)
        for _ in range(cfg.population)
    ]

    best_seen: list[tuple[float, list[int], dict]] = []

    # 种子：真正进入基因池（占据种群前几位，可被交叉/变异继承），
    # 同时进入 best_seen 保证排行。原实现用随机树占位，"再进化"实际
    # 是重掷骰子，种子基因从未参与繁殖。
    for k, raw_seed in enumerate(seeds):
        clean = [int(t) for t in raw_seed if isinstance(t, (int, float))]
        if not clean:
            continue
        tok, metrics, comp = eval_tokens(clean)
        if metrics is not None and tok is not None:
            best_seen.append((comp, tok, metrics))
        seed_tree = tokens_to_tree(clean)
        if seed_tree is not None and k < len(population):
            population[k] = seed_tree

    # v2: 因子族种子模板注入初始种群 20%~30%(方案 §9.1)——用户 seed_tokens
    # 优先占位,模板紧随其后,其余保持随机探索;注入先于任何 RNG 消耗,
    # 同 seed 结果确定
    if v2:
        from .seed_templates import seed_fraction, templates_for

        tpl_tokens = templates_for(rng._active_features or [])
        k_start = min(len(seeds), len(population))
        k_max = min(k_start + seed_fraction(cfg.population, tpl_tokens), len(population))
        for j in range(k_start, k_max):
            tpl = tpl_tokens[(j - k_start) % len(tpl_tokens)] if tpl_tokens else None
            if tpl is None:
                break
            population[j] = tokens_to_tree(tpl) or population[j]
            tok, metrics, comp = eval_tokens(tpl)
            if metrics is not None and tok is not None:
                best_seen.append((comp, tok, metrics))

    # 岛划分：每岛至少 5 个体；余数并入末岛。islands=1 时退化为原单岛。
    n_islands = max(1, min(int(cfg.islands), cfg.population // 5))
    island_size = cfg.population // n_islands
    populations: list[list] = [
        population[i * island_size : (i + 1) * island_size]
        for i in range(n_islands)
    ]
    populations[-1].extend(population[n_islands * island_size :])

    MIGRATE_EVERY = 5
    stagnation = _Stagnation(n_islands) if cfg.evolve_v2 else None

    for _gen in range(cfg.generations):
        _collect_between_generations()
        last_scored_per_island: list[list[tuple[float, list]]] = []
        for isl in range(n_islands):
            pop = populations[isl]
            scored: list[tuple[float, list, list[int] | None, dict | None]] = []
            for tree in pop:
                tokens, metrics, comp = eval_tree(tree)
                scored.append((comp, tree, tokens, metrics))
                if metrics is not None and tokens is not None:
                    best_seen.append((comp, tokens, metrics))
            scored.sort(key=lambda x: x[0], reverse=True)
            if not scored or scored[0][3] is None:
                last_scored_per_island.append([])
                continue
            if stagnation is not None:
                ranked = _rank_v2(scored)
                last_scored_per_island.append(ranked)
                restart = stagnation.update(isl, ranked[0][0])
                populations[isl] = _breed_v2(
                    ranked, len(pop), cfg, rng, feat_n, op_one, op_two, restart
                )
                continue
            last_scored_per_island.append(
                [(comp, tree) for comp, tree, _, _ in scored]
            )
            size = len(pop)
            elite_n = max(2, size // 10)
            elites = [_clone(t) for _, t, _, _ in scored[:elite_n]]
            new_pop = list(elites)
            while len(new_pop) < size:
                mom = _tournament(scored, rng)
                if rng.random() < cfg.crossover_p and len(scored) > 1:
                    dad = _tournament(scored, rng)
                    child = _crossover(mom, dad, rng)
                else:
                    child = _clone(mom)
                if rng.random() < cfg.mutation_p:
                    child = _mutate(
                        child, feat_n, op_one, op_two, rng, cfg.max_depth
                    )
                new_pop.append(child)
            populations[isl] = new_pop

        # 环状迁移：各岛 top-2 克隆替换下一岛 2 个随机成员（保总评估数不变）
        if n_islands > 1 and (_gen + 1) % MIGRATE_EVERY == 0:
            for isl in range(n_islands):
                donor = last_scored_per_island[isl][:2]
                if not donor:
                    continue
                nxt = populations[(isl + 1) % n_islands]
                if len(nxt) <= 2:
                    continue
                for _, tree in donor:
                    nxt[rng.randrange(len(nxt))] = _clone(tree)

    return _dedup_top(
        best_seen,
        cfg.top_n,
        test_bars=test_bars,
        timeframe=timeframe,
        cost=cfg.cost,
        use_test=use_test,
        walk_forward_folds=cfg.walk_forward_folds,
        all_bars=bars,
        train_bars=train_bars,
        trials=cfg.population * cfg.generations + len(seeds),
        live_fill_gate=cfg.live_fill_gate,
        cross_peers=cfg.cross_peers,
        selection_v2=cfg.selection_v2,
        live_entry_gate=cfg.live_entry_gate,
        plan=plan,
        head_trim=head_trim,
        execution_model=cfg.execution_model,
        joint_training=cfg.joint_training,
    )


def holdout_len(n_test: int) -> int:
    """selection_v2 封存段长度:测试段对半,前半验证、后半封存。

    两半都须 ≥ MIN_TEST_BARS 才切(否则封存段统计无意义),不足时返回 0
    (退化为不封存,其余增强照常)。组合评估等报告路径与遴选共用此口径。
    """
    return n_test // 2 if n_test >= 2 * MIN_TEST_BARS else 0


# 行为去重用的 train 段因子序列缓存:selection_v2 每代要对 ~300 个候选求
# 因子序列,跨代绝大部分重复。按元素总量限额(~3M 浮点 ≈ 24MB)LRU 淘汰。
_SERIES_CACHE: OrderedDict[tuple, np.ndarray | None] = OrderedDict()
_SERIES_CACHE_MAX_ELEMENTS = 3_000_000
_series_cache_elements = 0


def _cached_series(
    tokens: list[int],
    mat: np.ndarray,
    sig: tuple,
    bars: list | None = None,
) -> np.ndarray | None:
    global _series_cache_elements
    key = (tuple(int(t) for t in tokens), sig)
    if key in _SERIES_CACHE:
        _SERIES_CACHE.move_to_end(key)
        return _SERIES_CACHE[key]
    series = (
        execute_for_bars(tokens, mat, bars) if bars is not None else execute(tokens, mat)
    )
    _SERIES_CACHE[key] = series
    _series_cache_elements += 0 if series is None else int(series.size)
    while len(_SERIES_CACHE) > 1 and _series_cache_elements > _SERIES_CACHE_MAX_ELEMENTS:
        _, dropped = _SERIES_CACHE.popitem(last=False)
        _series_cache_elements -= 0 if dropped is None else int(dropped.size)
    return series


def _dedup_top(
    champions: list[tuple[float, list[int], dict]],
    top_n: int,
    *,
    test_bars: list[dict[str, Any]] | None = None,
    timeframe: str = "1d",
    cost: float = 0.0003,
    use_test: bool = False,
    walk_forward_folds: int = 0,
    all_bars: list[dict[str, Any]] | None = None,
    train_bars: list[dict[str, Any]] | None = None,
    trials: int = 0,
    live_fill_gate: bool = False,
    cross_peers: list[tuple[str, list[dict[str, Any]]]] | None = None,
    selection_v2: bool = False,
    live_entry_gate: float = 0.0,
    reveal_holdout: bool = True,
    plan: SplitPlan | None = None,
    head_trim: int = 0,
    execution_model: str = "signal_research",
    joint_training: bool = False,
) -> list[Champion]:
    """去重并取 top-N，可选叠加测试段验证与 walk-forward 淘汰

    三重防线（防过拟合 + 防空结果）：
    1. shortlist：先按训练 composite 固定取 max(3·top_n, top_n+5) 个候选，
       测试段/WF 只在这份有界名单上一次性验证——此前按序对全量 best_seen
       迭代淘汰，holdout 被反复用作过滤器，幸存者 test 指标系统性上偏。
    2. 严格筛：测试段 sortino>0（1×与 2×成本）且 walk-forward 全折为正，
       并做因子相关性去重（train 段 |corr|>0.9 视为同一因子，只留最优）。
    3. 兜底回退：严格筛后为空时回退 shortlist 前 top_N，标注 overfit_warning
       （前端已禁止收藏/挂载该类因子）。

    selection_v2（本地增强，默认关）：测试段切出封存段（见 holdout_len），
    shortlist 改为行为去重后的 ~30 个不同因子，冠军附 holdout_metrics/dsr。
    live_entry_gate>0：严格筛追加验证段实盘离散口径 sortino>0。

    crypto_local_v2（plan 非 None）：test_bars 即验证区 [train_end,
    validation_end)（调用方已裁掉封存段）；验证折走 walk_forward_eval_v2
    （计分只在验证区内,上下文允许进训练区）;样本不足时兜底冠军带
    insufficient_samples + 具体缺口,不再以 overfit_warning 冒充通过。
    封存段评估由调用方(factor_local)在最终代做一次性揭示,本函数不触碰。
    """
    # selection_v2 封存段：从尾部切走，之后的一切筛选（测试段/WF/保守 OOS/
    # 跨品种）都只看得到切走后的数据；封存段仅在 _enrich 报告一次
    # v2 不走该机制(封存由 SplitPlan 显式持有,调用方已裁掉)
    full_bars = all_bars
    n_holdout = 0
    if selection_v2 and plan is None and use_test and test_bars and all_bars:
        n_holdout = holdout_len(len(test_bars))
        if n_holdout:
            test_bars = test_bars[: len(test_bars) - n_holdout]
            all_bars = all_bars[: len(all_bars) - n_holdout]
            if cross_peers:
                # 伙伴品种同样不许看封存期（同期行情跨品种高度相关）
                cut_time = str(full_bars[len(full_bars) - n_holdout].get("time") or "")
                cross_peers = [
                    (peer, [b for b in pb if str(b.get("time") or "") < cut_time])
                    for peer, pb in cross_peers
                ]
    # 先按 composite 降序去重，作为两轮筛选的统一候选池
    seen: set[tuple[int, ...]] = set()
    uniq: list[tuple[float, list[int], dict]] = []
    for comp, tokens, metrics in sorted(
        champions, key=lambda x: x[0], reverse=True
    ):
        key = tuple(tokens)
        if key in seen:
            continue
        seen.add(key)
        uniq.append((comp, tokens, metrics))

    # shortlist：holdout 只暴露给有界候选集
    shortlist = uniq[: max(top_n * 3, top_n + 5)]
    # champion 数量随试验数收缩（P5）：样本内指标是 trials 次尝试的最优值，
    # 试验少却宣称很多冠军 = 多重检验裸奔。√ 增长：证据强度亚线性于试验数。
    n_cap = top_n
    if trials > 0:
        n_cap = max(2, min(top_n, round((trials ** 0.5) / 2)))

    # 相关性去重用的因子序列（train 段；lazy 计算）
    corr_mat = None
    corr_sig: tuple = ()
    corr_factors: list[np.ndarray] = []
    if train_bars:
        corr_mat = feature_matrix(train_bars)
        corr_sig = bars_signature(train_bars)

    def _factor_series(tokens: list[int]) -> np.ndarray | None:
        if corr_mat is None:
            return None
        if selection_v2:
            series = _cached_series(tokens, corr_mat, corr_sig, train_bars)
        else:
            series = execute_for_bars(tokens, corr_mat, train_bars) if train_bars else execute(tokens, corr_mat)
        # v2 共享计分日历:相关性去重同样从头部裁剪之后比较
        if series is not None and head_trim:
            series = series[head_trim:]
        return series

    def _corr_dup(factor: np.ndarray | None) -> bool:
        """与已入选因子的相关性 > 0.9 视为重复"""
        if factor is None:
            return False
        for g in corr_factors:
            if len(factor) != len(g):
                continue
            fa = factor - factor.mean()
            ga = g - g.mean()
            sd = float(fa.std() * ga.std())
            if sd < 1e-12:
                return True  # 常数因子对重复因子判定为重复
            if abs(float((fa * ga).mean()) / sd) > 0.9:
                return True
        return False

    def _conservative_oos(tokens: list[int]) -> float | None:
        """保守 OOS（P5）：测试段四等分取最差子段 sortino——样本外收益
        的保守下界参考，防"平均为正、最差季度巨亏"的冠军蒙混过关"""
        if not test_bars or len(test_bars) < 4 * MIN_TEST_BARS:
            return None
        q = len(test_bars) // 4
        lo_test = len(all_bars) - len(test_bars) if all_bars else 0
        worst = None
        for k in range(4):
            a = lo_test + k * q
            b = lo_test + (k + 1) * q if k < 3 else len(all_bars)
            m = evaluate_on_slice(tokens, all_bars, a, b, timeframe, cost)
            if m is None:
                continue
            sv = float(m["sortino"])
            worst = sv if worst is None else min(worst, sv)
        return worst

    def _enrich_v2(enriched: dict, tokens: list[int]) -> None:
        """selection_v2 报告项：封存段指标（唯一一次触碰封存段）+ Deflated Sharpe"""
        if reveal_holdout and n_holdout and full_bars:
            lo_h = len(full_bars) - n_holdout
            hm = evaluate_on_slice(tokens, full_bars, lo_h, len(full_bars), timeframe, cost)
            if hm is not None:
                if live_entry_gate > 0:
                    lm = live_discrete_on_slice(
                        tokens, full_bars, lo_h, len(full_bars), timeframe, cost,
                        live_entry_gate,
                    )
                    if lm is not None:
                        hm["live_discrete_sortino"] = lm["sortino"]
                        hm["live_discrete_ann_ret"] = lm["ann_ret"]
                enriched["holdout_metrics"] = hm
        # DSR 用训练段 pnl（与遗传搜索适应度同一段、同一口径）
        factor = _factor_series(tokens)
        if factor is not None and train_bars and trials > 0:
            from .scoring.deflated import deflated_sharpe

            close = np.array([float(b.get("close") or 0) for b in train_bars], dtype=float)
            pos = position_from_factor(factor)
            prev = np.roll(pos, 1)
            prev[0] = 0.0
            pnl = pos * next_ret(close) - np.abs(pos - prev) * cost
            dsr = deflated_sharpe(pnl, trials)
            if dsr is not None:
                enriched["dsr"] = round(dsr, 4)

    def _enrich(
        comp: float,
        tokens: list[int],
        metrics: dict,
        cross_scores: dict[str, float] | None = None,
    ) -> Champion:
        """附 train/test/walk_forward 子键构造 Champion"""
        enriched = dict(metrics)
        from .market import is_crypto, CRYPTO_PROFILE, V2_PROFILE
        if is_crypto(train_bars or all_bars or []):
            marker = (train_bars or all_bars or [""])[0].get("_factor_market")
            profile_id = marker if marker in (CRYPTO_PROFILE, V2_PROFILE) else CRYPTO_PROFILE
            enriched["crypto_profile"] = True
            enriched["research_profile"] = profile_id
            enriched["periods"] = bars_per_year(train_bars or all_bars, timeframe)
            enriched["cost"] = cost
            enriched["cost_model"] = "static_fee_plus_tick_no_funding"
            source = (train_bars or all_bars)[0].get("market_source")
            if source:
                enriched["data_channel"] = source
            if source == "gate_usdt" or any(52 <= t < 64 for t in tokens):
                enriched["research_only"] = True

        if plan is not None:
            # v2:切分计划随结果冻结,报告直接消费同一对象(方案 5.1-7)
            enriched["split_plan"] = plan.to_summary()
            if not plan.sufficient:
                enriched["insufficient_samples"] = True
                enriched["sample_gaps"] = list(plan.insufficiency_reasons)

        if use_test and train_bars:
            train_m = evaluate_on_slice(tokens, all_bars, 0, len(train_bars), timeframe, cost)
            if train_m is not None:
                enriched["train_metrics"] = train_m
        if use_test and test_bars:
            lo_test = len(all_bars) - len(test_bars) if all_bars else 0
            test_m = evaluate_on_slice(tokens, all_bars, lo_test, len(all_bars), timeframe, cost)
            if test_m is not None:
                enriched["test_metrics"] = test_m
                if plan is not None:
                    enriched["validation_metrics"] = test_m
        if walk_forward_folds > 0 and all_bars:
            # P1-8:传入训练段长度,前几折落在训练段内的标记 in_train,
            # wf_stable 只按样本外折判定(UI 据 folds[].in_train 区分展示)
            # v2:验证折只在验证区内切分(walk_forward_eval_v2)
            if plan is not None:
                wf = walk_forward_eval_v2(
                    tokens, all_bars, timeframe, cost, plan, walk_forward_folds
                )
            else:
                wf = walk_forward_eval(
                    tokens, all_bars, timeframe, cost, walk_forward_folds,
                    train_len=len(train_bars) if train_bars else None,
                )
            if wf is not None:
                enriched["walk_forward"] = wf
        if cross_scores:
            enriched["cross_symbol"] = {
                k: round(v, 3) for k, v in cross_scores.items()
            }
        if plan is not None and execution_model in ("perp_next_open", "spot_long_flat"):
            exec_m = _executable_metrics_for(tokens, 1.0)
            if exec_m is not None:
                enriched["execution_metrics"] = exec_m
        cons = _conservative_oos(tokens)
        if cons is not None:
            enriched["oos_conservative"] = round(cons, 4)
        if use_test and test_bars:
            try:
                from factor_lab.scoring.regime import (
                    regime_decompose,
                )

                lo_test = len(all_bars) - len(test_bars) if all_bars else 0
                prefix = (
                    all_bars[0 if is_crypto(all_bars) or any(40 <= t < 64 or t >= 104 for t in tokens) else max(0, lo_test - WARMUP_BARS) : lo_test] if all_bars else []
                )
                reg = regime_decompose(
                    tokens, test_bars, timeframe, cost, prefix_bars=prefix
                )
                if reg is not None:
                    enriched["regime"] = reg
            except Exception:
                pass  # 报告指标，失败不影响冠军构造
        if trials > 0:
            enriched["trials"] = trials
        if selection_v2:
            _enrich_v2(enriched, tokens)
        return Champion(
            tokens=list(tokens),
            text=to_text(tokens),
            metrics=enriched,
            composite=comp,
        )

    def _passes_strict(tokens: list[int]) -> tuple[bool, dict[str, float]]:
        """严格筛：测试段 sortino>0（成本 1×与 2×敏感性均须为正）且 WF 全折为正

        2×成本敏感性：线性成本模型低估高换手因子的真实代价，滑点按 2 tick
        仍存活说明收益不是靠边际成本差刷出来的。
        live_fill_gate：测试段"次根开盘成交"口径 sortino>0（模拟 vs 实盘缺口）。
        cross_peers：≥⌈K/2⌉ 个同板块伙伴品种 sortino>0（跨品种迁移验证）。
        返回 (是否通过, 跨品种得分明细供 metrics 记录)。
        """
        cross_scores: dict[str, float] = {}
        if use_test and test_bars:
            lo_test = len(all_bars) - len(test_bars) if all_bars else 0
            test_m = evaluate_on_slice(tokens, all_bars, lo_test, len(all_bars), timeframe, cost)
            if test_m is None or test_m["sortino"] <= 0.0:
                return False, cross_scores
            test_m2 = evaluate_on_slice(
                tokens, all_bars, lo_test, len(all_bars), timeframe, cost * 2.0
            )
            if test_m2 is None or test_m2["sortino"] <= 0.0:
                return False, cross_scores
            if live_fill_gate and test_m.get("live_fill_sortino", 0.0) <= 0.0:
                return False, cross_scores
            if live_entry_gate > 0:
                lm = live_discrete_on_slice(
                    tokens, all_bars, lo_test, len(all_bars), timeframe, cost,
                    live_entry_gate,
                )
                if lm is None or lm["sortino"] <= 0.0:
                    return False, cross_scores
        if walk_forward_folds > 0 and all_bars:
            if plan is not None:
                wf = walk_forward_eval_v2(
                    tokens, all_bars, timeframe, cost, plan, walk_forward_folds
                )
            else:
                wf = walk_forward_eval(
                    tokens, all_bars, timeframe, cost, walk_forward_folds,
                    train_len=len(train_bars) if train_bars else None,
                )
            if wf is None or not wf["wf_stable"]:
                return False, cross_scores
        if plan is not None and execution_model in ("perp_next_open", "spot_long_flat"):
            # v2(方案 §7):新合格状态统一以所选 executionModel 的净收益验证。
            # 1×与 2×成本压力(仅放大交易费用/滑点,funding 按事件原值)下
            # 验证区可执行净 sortino 均 >0。perp 无 funding 事件 = 关键成本
            # 未知,不得默认通过。
            if not _executable_gate(tokens, cross_scores):
                return False, cross_scores
        if cross_peers:
            if joint_training and train_bars:
                # 联合训练:伙伴训练窗已进适应度,只在其后的时间窗上验证
                from factor_lab.joint_training import cross_validate_window

                ok, cross_scores = cross_validate_window(
                    tokens, cross_peers, timeframe, cost,
                    str(train_bars[-1].get("time") or ""),
                )
            else:
                from factor_lab.cross_symbol import cross_validate_tokens

                ok, cross_scores = cross_validate_tokens(
                    tokens, cross_peers, timeframe, cost
                )
            if not ok:
                return False, cross_scores
        return True, cross_scores

    def _executable_metrics_for(tokens: list[int], stress: float) -> dict | None:
        """验证区可执行口径指标(v2;上下文含训练段,现金流连续推进后取验证段)"""
        if plan is None or not train_bars or all_bars is None:
            return None
        from factor_lab.scoring.execution import ExecutionConfig, executable_metrics

        lo_test = len(all_bars) - len(test_bars) if test_bars else plan.train_end
        if lo_test <= 0 or lo_test >= len(all_bars) - 2:
            return None
        ctx_bars = all_bars  # 已由调用方截到 validation_end;训练段作上下文
        mat_ctx = feature_matrix(ctx_bars)
        factor_ctx = execute_for_bars(tokens, mat_ctx, ctx_bars)
        if factor_ctx is None:
            return None
        cfg_exec = ExecutionConfig(
            fee_rate=cost, slippage_bps=0.0,
            execution_model=execution_model, stress_multiplier=stress,
        )
        return executable_metrics(
            factor_ctx, ctx_bars, timeframe, cfg_exec, lo=lo_test, hi=len(ctx_bars)
        )

    def _executable_gate(tokens: list[int], cross_scores: dict) -> bool:
        if not (use_test and test_bars):
            return True  # 无验证区(探索模式)时不拦截,由 insufficient 标记兜底
        for stress in (1.0, 2.0):
            m = _executable_metrics_for(tokens, stress)
            if m is None or m["sortino"] <= 0.0:
                return False
            if execution_model == "perp_next_open" and m.get("n_funding_events", 0) == 0:
                # 关键成本未知(funding 缺失):不得默认通过
                cross_scores["executable"] = "missing_funding_events"
                return False
        return True

    # 第一轮：严格筛 + 相关性去重。PBO 分母限定在前 2×n_cap 个候选
    # （完整计数会显著拖慢搜索；前 2×n_cap 已是"训练最优"核心区，失败率
    # 估计代表性足够，分母同步标注为该区间大小）
    pbo_pool = shortlist[: max(2 * n_cap, n_cap + 10)]
    if selection_v2:
        # 行为去重先行：原 pbo_pool 是训练分最高的 ~20 个公式，GP 收敛后多为
        # 同一因子的变体，严格筛实际只看到两三个想法；且搜得越多，头部越是
        # "最会拟合训练段"的变体。这里按训练分降序扫描，指纹相同的免执行
        # 跳过、|corr|>0.9 的跳过，凑满 target 个互不相同的因子再去验证。
        target = max(3 * top_n, 30)
        distinct: list[tuple[float, list[int], dict]] = []
        robust_of: dict[tuple[int, ...], float] = {}
        train_close = (
            np.array([float(b.get("close") or 0) for b in train_bars], dtype=float)[head_trim:]
            if train_bars else None
        )
        periods_tr = bars_per_year(train_bars, timeframe) if train_bars else 0
        fps: set[tuple] = set()
        scan_pos = 0

        def _fill_distinct(limit: int) -> list[tuple[float, list[int], dict]]:
            """从 uniq 的 scan_pos 处继续扫描,凑 limit 个互不相同的因子"""
            nonlocal scan_pos
            got: list[tuple[float, list[int], dict]] = []
            scanned = 0
            while scan_pos < len(uniq) and len(got) < limit and scanned < limit * 10:
                item = uniq[scan_pos]
                scan_pos += 1
                fp = _metric_fingerprint(item[2])
                if fp is not None:
                    if fp in fps:
                        continue
                    fps.add(fp)
                scanned += 1
                factor = _factor_series(item[1])
                if factor is None or _corr_dup(factor):
                    continue
                corr_factors.append(factor)
                if train_close is not None and periods_tr:
                    pf, ms = _block_robustness(factor, train_close, cost, periods_tr)
                    robust_of[tuple(item[1])] = _robust_key(item[0], pf, ms)
                got.append(item)
            # 分块稳健的候选先验证:n_cap 截断时优先保留"各段行情都赚"的因子
            got.sort(key=lambda x: robust_of.get(tuple(x[1]), x[0]), reverse=True)
            return got

        distinct = _fill_distinct(target)
        shortlist = distinct
        pbo_pool = distinct
    strict_pool: list[tuple[float, list[int], dict, dict[str, float]]] = []
    n_failed = 0
    # v2 样本不足:无验证区,严格筛会空转通过(use_test=False 时门全开)——
    # 直接跳过严格轮,所有候选走探索路径,不得输出 validation_passed
    v2_insufficient = plan is not None and not plan.sufficient
    if not v2_insufficient:
        pool_iter = list(pbo_pool)
        extensions = 0
        while True:
            for comp, tokens, metrics in pool_iter:
                ok, cross_scores = _passes_strict(tokens)
                if not ok:
                    n_failed += 1
                    continue
                if not selection_v2:  # v2 的池已行为去重
                    factor = _factor_series(tokens)
                    if _corr_dup(factor):
                        continue
                    if factor is not None:
                        corr_factors.append(factor)
                strict_pool.append((comp, tokens, metrics, cross_scores))
            # selection_v2 最终代:通过数不足 n_cap 时再往下扫最多 2 批不同因子
            # (训练最优的头部常是最会拟合训练段的,真正稳健的因子可能排在后面)。
            # 只多用验证区做筛选,封存段仍对筛选全程不可见,holdout 指标仍无偏;
            # 被判定的候选全部计入 PBO 分母。中间代不扩展,避免每代双倍开销。
            if not (selection_v2 and reveal_holdout and len(strict_pool) < n_cap and extensions < 2):
                break
            pool_iter = _fill_distinct(target)
            if not pool_iter:
                break
            extensions += 1
            pbo_pool = pbo_pool + pool_iter
            shortlist = pbo_pool

    # PBO 代理（P5）：训练段最优 K 个候选中样本外失败的比例，
    # 即"训练赢家样本外翻车"的经验概率估计。
    # 注:P2-20 的建议(分母改为"真正做过 _passes_strict 判定的个数")经核对
    # 是无操作——_corr_dup 去重发生在判定之后,池内所有候选都被判定过,
    # len(pbo_pool) 即判定数;文档描述与现行代码不符,维持原样。
    pbo_proxy = round(n_failed / len(pbo_pool), 3) if pbo_pool and use_test else None

    strict_out = [
        _enrich(comp, tokens, metrics, cross_scores)
        for comp, tokens, metrics, cross_scores in strict_pool[:n_cap]
    ]
    if pbo_proxy is not None:
        for c in strict_out:
            c.metrics["pbo_proxy"] = pbo_proxy
    if plan is not None:
        # v2:通过严格筛 = 验证区(1×/2×成本+折)通过;封存尚未揭示
        for c in strict_out:
            c.metrics["validation_passed"] = True
            c.metrics["candidate_status"] = "validation_passed"
    if strict_out:
        return strict_out

    # 第二轮：兜底回退。严格筛全军覆没时（超长数据常见），取 shortlist 前 n_cap，
    # 标 overfit_warning 让用户知道这些因子测试段表现差，而非返回空。
    fallback: list[Champion] = []
    for comp, tokens, metrics in shortlist[:n_cap]:
        c = _enrich(comp, tokens, metrics)
        if plan is not None:
            # v2:样本不足 → 探索(带缺口明细);样本够但严格筛全灭 → 拒绝。
            # 两者都不计入合格因子数,不以 overfit_warning 冒充通过。
            if not plan.sufficient:
                c.metrics["candidate_status"] = "exploratory"
                c.metrics["exploratory_reason"] = (
                    "样本不足,仅探索: " + "; ".join(plan.insufficiency_reasons)
                )
            else:
                c.metrics["candidate_status"] = "rejected"
            c.metrics["overfit_warning"] = (
                "验证区未通过严格筛(样本不足或 sortino/WF 不达标):"
                "该结果仅供研究参考,不计入合格因子数。"
            )
        else:
            c.metrics["overfit_warning"] = (
                "测试段 sortino≤0 或 walk-forward 不稳健：该因子在搜索时未见的"
                "近期数据上亏损，过拟合风险高，仅供参考。"
            )
        fallback.append(c)
    return fallback


# ── 分代步进版（供超级因子挖掘长程任务使用） ──────────────────


@dataclass
class StepwiseSnapshot:
    """每代步进的进度快照，由 loop 层持久化到 DB"""

    generation: int  # 当前已完成代数（0-based，=已跑的代数）
    total_generations: int
    best_composite: float  # 截至本代的最优综合分
    champions: list[Champion]  # 截至本代去重 top-N（仅最终代为正式结果）
    stats: dict | None = None  # 漏斗计数/淘汰原因(任务1/10,旁路统计)


def search_stepwise(
    bars: list[dict[str, Any]],
    timeframe: str,
    cfg: SearchConfig,
    start_generation: int = 0,
    seed_best: list[tuple[float, list[int], dict]] | None = None,
):
    """search 的分代步进生成器版本。

    与 search() 行为一致（同样的切分、遗传算子、防过拟合淘汰），区别：
    - 每代结束后 yield StepwiseSnapshot，调用方可据此上报进度、持久化、检查取消。
    - 支持 start_generation：从指定代数续跑（断点续训），seed_best 注入历史最优。
    - 调用方在每次 yield 后检查任务是否被取消/暂停，若需中止直接不再迭代即可。

    用法：
        gen = search_stepwise(bars, tf, cfg, start_generation=task.current_generation,
                              seed_best=historical_best)
        for snapshot in gen:
            persist(snapshot)  # 写回 DB
            if task_cancelled():
                break
        final = _dedup_top(...)  # 用累积的 best_seen 做最终去重

    返回的生成器在迭代结束后，best_seen 不再保留（生成器局部状态），
    故每代 snapshot 已含去重 top-N，最终代 snapshot.champions 即可作结果。
    """
    # ── 切分（与 search() 同源）──────────────────────────────
    v2 = is_v2_config(cfg)
    plan: SplitPlan | None = None
    if v2:
        plan = build_split_plan(
            len(bars), label_span=cfg.label_span, warmup=WARMUP_BARS, bars=bars
        )
        if plan.sufficient:
            bars = list(bars[: plan.validation_end])
            train_bars = list(bars[: plan.train_end])
            test_bars = list(bars[plan.train_end :])
        else:
            train_bars, test_bars = list(bars), []
    elif cfg.test_recent_bars > 0:
        cut = max(MIN_TEST_BARS, len(bars) - cfg.test_recent_bars)
        if cut < MIN_TEST_BARS or (len(bars) - cut) < MIN_TEST_BARS:
            train_bars, test_bars = list(bars), []
        else:
            train_bars, test_bars = list(bars[:cut]), list(bars[cut:])
    elif cfg.train_ratio > 0.0:
        train_bars, test_bars = split_bars(bars, cfg.train_ratio)
    else:
        train_bars, test_bars = list(bars), []
    use_test = bool(test_bars) and len(test_bars) >= MIN_TEST_BARS
    if v2:
        use_test = plan is not None and plan.sufficient

    feat_mat = feature_matrix(train_bars)
    close = np.array([float(b.get("close") or 0) for b in train_bars], dtype=float)
    periods = bars_per_year(train_bars, timeframe)
    feat_n = feat_mat.shape[0] if (cfg.crypto_profile or v2) else min(40, feat_mat.shape[0])
    rng = random.Random(cfg.seed)
    op_one, op_two = _search_space(feat_mat, cfg, rng)
    head_trim = _v2_head_trim(feat_mat, rng._active_features or []) if v2 else 0
    cached_eval = _training_evaluator(
        feat_mat, close, cfg.cost, periods, trim=head_trim, bars=train_bars if v2 else None,
        robust=cfg.evolve_v2,
    )
    if cfg.joint_training and cfg.cross_peers:
        from .joint_training import build_joint_context, wrap_evaluator

        cached_eval = wrap_evaluator(
            cached_eval,
            build_joint_context(cfg.cross_peers, train_bars, timeframe, v2),
            cfg.cost, v2,
        )

    # 漏斗计数(任务1/10):旁路统计,不侵入任何评估数值
    from .scoring.research_report import SearchStats

    stats = SearchStats()

    def _eval_with_stats(tokens_tuple: tuple):
        stats.note_generated()
        tok, metrics, comp = cached_eval(tokens_tuple)
        if tok is None:
            if validate(list(tokens_tuple)):
                stats.note_invalid_syntax("invalid_syntax")
            else:
                stats.note_syntax_valid()
                stats.note_execution(list(tokens_tuple), False, "not_train_valid", None)
        else:
            stats.note_syntax_valid()
            stats.note_execution(list(tokens_tuple), True, None, metrics)
        return tok, metrics, comp

    def eval_tree(tree: list):
        return _eval_with_stats(tuple(tree_to_tokens(tree)))

    def eval_tokens(tokens: list[int]):
        return _eval_with_stats(tuple(tokens))

    # 初始种群
    population = [
        _random_tree(cfg.max_depth, feat_n, op_one, op_two, rng)
        for _ in range(cfg.population)
    ]

    # best_seen：注入历史最优（断点续训）+ 种子（种子同时进基因池，见上）
    best_seen: list[tuple[float, list[int], dict]] = []
    if seed_best:
        best_seen.extend(seed_best)
    for k, raw_seed in enumerate((cfg.seed_tokens or [])):
        clean = [int(t) for t in raw_seed if isinstance(t, (int, float))]
        if not clean:
            continue
        tok, metrics, comp = eval_tokens(clean)
        if metrics is not None and tok is not None:
            best_seen.append((comp, tok, metrics))
        seed_tree = tokens_to_tree(clean)
        if seed_tree is not None and k < len(population):
            population[k] = seed_tree

    # v2: 因子族种子模板注入初始种群 20%~30%(方案 §9.1)——用户 seed_tokens
    # 优先占位,模板紧随其后,其余保持随机探索;注入先于任何 RNG 消耗,
    # 同 seed 结果确定
    if v2:
        from .seed_templates import seed_fraction, templates_for

        tpl_tokens = templates_for(rng._active_features or [])
        k_start = min(len(cfg.seed_tokens or []), len(population))
        k_max = min(k_start + seed_fraction(cfg.population, tpl_tokens), len(population))
        for j in range(k_start, k_max):
            tpl = tpl_tokens[(j - k_start) % len(tpl_tokens)] if tpl_tokens else None
            if tpl is None:
                break
            population[j] = tokens_to_tree(tpl) or population[j]
            tok, metrics, comp = eval_tokens(tpl)
            if metrics is not None and tok is not None:
                best_seen.append((comp, tok, metrics))

    # 岛划分（与 search() 同款）：islands=1 退化为单岛
    n_islands = max(1, min(int(cfg.islands), cfg.population // 5))
    island_size = cfg.population // n_islands
    populations: list[list] = [
        population[i * island_size : (i + 1) * island_size]
        for i in range(n_islands)
    ]
    populations[-1].extend(population[n_islands * island_size :])
    MIGRATE_EVERY = 5
    stagnation = _Stagnation(n_islands) if cfg.evolve_v2 else None

    # ── 主循环：分代步进 ─────────────────────────────────────
    for gen_idx in range(cfg.generations):
        # 断点续训：跳过已完成的代
        if gen_idx < start_generation:
            continue

        island_scored: list[list[tuple[float, list, list[int] | None, dict | None]]] = []
        any_valid = False
        for isl in range(n_islands):
            scored: list[tuple[float, list, list[int] | None, dict | None]] = []
            for tree in populations[isl]:
                tokens, metrics, comp = eval_tree(tree)
                scored.append((comp, tree, tokens, metrics))
                if metrics is not None and tokens is not None:
                    best_seen.append((comp, tokens, metrics))
            scored.sort(key=lambda x: x[0], reverse=True)
            island_scored.append(scored)
            if scored and scored[0][3] is not None:
                any_valid = True
        if not any_valid:
            break

        # 产出本代进度快照（去重 top-N，含防过拟合淘汰——与 search() 同口径）
        cur_champions = _dedup_top(
            list(best_seen),
            cfg.top_n,
            test_bars=test_bars,
            timeframe=timeframe,
            cost=cfg.cost,
            use_test=use_test,
            walk_forward_folds=cfg.walk_forward_folds,
            all_bars=bars,
            train_bars=train_bars,
            trials=cfg.population * cfg.generations + len(cfg.seed_tokens or []),
            live_fill_gate=cfg.live_fill_gate,
            cross_peers=cfg.cross_peers,
            selection_v2=cfg.selection_v2,
            reveal_holdout=gen_idx == cfg.generations - 1,
            live_entry_gate=cfg.live_entry_gate,
            plan=plan,
            head_trim=head_trim,
            execution_model=cfg.execution_model,
            joint_training=cfg.joint_training,
        )
        best_comp = max((c.composite for c in cur_champions), default=-999.0)
        snap_stats = dict(stats.to_dict())
        snap_stats["champions"] = SearchStats.summarize(
            [{"metrics": c.metrics} for c in cur_champions]
        )
        yield StepwiseSnapshot(
            generation=gen_idx + 1,
            total_generations=cfg.generations,
            best_composite=best_comp,
            champions=cur_champions,
            stats=snap_stats,
        )

        # 进化下一代种群（每岛：精英 + 锦标赛 + 交叉/变异）
        # evolve_v2 的迁移供体取繁殖排序键 top-2(克隆降权后),与 search() 一致
        migrants: list[list[list]] = [
            [t for _, t, _, _ in s[:2]] for s in island_scored
        ]
        for isl in range(n_islands):
            scored = island_scored[isl]
            if not scored or scored[0][3] is None:
                continue
            size = len(populations[isl])
            if stagnation is not None:
                ranked = _rank_v2(scored)
                migrants[isl] = [t for _, t in ranked[:2]]
                restart = stagnation.update(isl, ranked[0][0])
                populations[isl] = _breed_v2(
                    ranked, size, cfg, rng, feat_n, op_one, op_two, restart
                )
                continue
            elite_n = max(2, size // 10)
            elites = [_clone(t) for _, t, _, _ in scored[:elite_n]]
            new_pop = list(elites)
            while len(new_pop) < size:
                mom = _tournament(scored, rng)
                if rng.random() < cfg.crossover_p and len(scored) > 1:
                    dad = _tournament(scored, rng)
                    child = _crossover(mom, dad, rng)
                else:
                    child = _clone(mom)
                if rng.random() < cfg.mutation_p:
                    child = _mutate(
                        child, feat_n, op_one, op_two, rng, cfg.max_depth
                    )
                new_pop.append(child)
            populations[isl] = new_pop

        # 环状迁移：各岛 top-2 克隆替换下一岛 2 个随机成员
        if n_islands > 1 and (gen_idx + 1) % MIGRATE_EVERY == 0:
            for isl in range(n_islands):
                donor = migrants[isl]
                if not donor:
                    continue
                nxt = populations[(isl + 1) % n_islands]
                if len(nxt) <= 2:
                    continue
                for tree in donor:
                    nxt[rng.randrange(len(nxt))] = _clone(tree)
