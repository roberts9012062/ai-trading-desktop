"""有界候选档案(crypto_local_v2,方案 §8.1)

背景(方案 2.1-E):run_mine_precise 把 best_seen 按训练分截前 60;但
selection_v2 的行为去重要扫 ~300 个候选才凑得出 30 个不同想法。头部被
同质变体占满时,截断会系统性丢掉后部的互补候选,下一代也失去差异基因。

本模块把「展示 top_n」「进化精英」「待验证档案」分离:
- top_n:最终展示数量(默认 10,不变);
- archive_capacity:跨代传递的有界档案(默认 256;取代裸截 60);
- validation_budget:整个运行累计的唯一验证候选上限(默认 60;防重复
  读取验证结果形成选择压力——由调用方计数,本模块提供扣减接口)。

保留配额(默认):50% 训练稳健性较好、30% 不同行为/因子族、20% 探索。
各区重叠去重(同一 tokens 只占一个名额),空位按确定性规则回填
(训练分降序)。分组维度:主要因子族 × 复杂度档 × 换手档。

纪律:
- 只有训练指标参与保留决策;验证/封存结果不进档案(方案 §8.2);
- 指纹(ann/sortino/ic 三元组)只作近似索引;碰撞族内仍按 tokens 去重;
- 输出确定性:同输入同种子同结果(无随机;「探索」配额用稳定哈希序)。
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from typing import Any

# 默认配额与容量(方案 §8.1;可由调用方按内存预算覆盖)
DEFAULT_ARCHIVE_CAPACITY = 256
DEFAULT_QUOTA_ROBUST = 0.5
DEFAULT_QUOTA_DIVERSE = 0.3
DEFAULT_QUOTA_EXPLORE = 0.2

FEAT_OFFSET = 64
MAX_FEATURES = 64


def family_of(tokens: list[int]) -> str:
    """主要因子族:按公式用到的最高优先级数据来源分族。"""
    feats = [int(t) for t in tokens if int(t) < FEAT_OFFSET]
    if any(52 <= f <= 58 for f in feats):
        return "direct_deriv"      # 直连衍生品/成交微结构
    if any(40 <= f <= 51 for f in feats):
        return "crypto_v1"         # 加密扩展(动量/流动性/时钟)
    return "ohlcv_legacy"          # 传统 OHLCV 量价


def complexity_band(tokens: list[int]) -> int:
    """复杂度档:token 数 /4 截断到 [0,4](短/中/长/超长公式)。"""
    return min(len(tokens) // 4, 4)


def turnover_band(metrics: dict | None) -> int:
    """换手档:avg_turnover 的固定阈值分档(0 低频 .. 3 高频)。"""
    to = float((metrics or {}).get("avg_turnover") or 0.0)
    if to < 0.05:
        return 0
    if to < 0.15:
        return 1
    if to < 0.4:
        return 2
    return 3


def group_key(tokens: list[int], metrics: dict | None) -> tuple:
    return (family_of(tokens), complexity_band(tokens), turnover_band(metrics))


def _stable_hash(tokens: list[int]) -> int:
    return int.from_bytes(
        hashlib.sha256(",".join(str(int(t)) for t in tokens).encode()).digest()[:8],
        "little",
    )


def metric_fingerprint(metrics: dict | None) -> tuple | None:
    """行为指纹(ann/sortino/ic 三元组)——仅作近似索引,不用于丢弃。"""
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


def _robust_ok(metrics: dict | None) -> bool:
    """训练稳健性较好的判据(只用训练指标):样本外折非负 + 半段一致非负。"""
    if not metrics:
        return False
    if metrics.get("oos_negative"):
        return False
    return float(metrics.get("consistency") or 0.0) >= 0.0


@dataclass
class BoundedArchive:
    """跨代传递的有界档案。add() 全量累积,snapshot() 做配额裁剪。

    只在快照时裁剪,保留期内不丢弃——同代内多次快照结果一致。
    """

    capacity: int = DEFAULT_ARCHIVE_CAPACITY
    quota_robust: float = DEFAULT_QUOTA_ROBUST
    quota_diverse: float = DEFAULT_QUOTA_DIVERSE
    quota_explore: float = DEFAULT_QUOTA_EXPLORE
    _items: dict[tuple[int, ...], tuple[float, list[int], dict]] = field(default_factory=dict)

    def add(self, comp: float, tokens: list[int], metrics: dict) -> None:
        key = tuple(int(t) for t in tokens)
        cur = self._items.get(key)
        if cur is None or comp > cur[0]:
            self._items[key] = (float(comp), [int(t) for t in tokens], metrics)

    def extend(self, entries: list[tuple[float, list[int], dict]]) -> None:
        for comp, tokens, metrics in entries:
            self.add(comp, tokens, metrics)

    def __len__(self) -> int:
        return len(self._items)

    def snapshot(self) -> list[tuple[float, list[int], dict]]:
        """配额裁剪后的档案(确定性):50% 稳健 / 30% 多样 / 20% 探索。

        - 稳健区:训练分降序的稳健候选;
        - 多样区:按 (族,复杂度,换手) 分组轮转取组内最优;
        - 探索区:未入区候选按稳定哈希序(等价固定随机种子的确定性抽样);
        - 三区重叠去重;空位按训练分降序回填。
        """
        pool = sorted(self._items.values(), key=lambda x: x[0], reverse=True)
        if len(pool) <= self.capacity:
            return [(c, t, m) for c, t, m in pool]
        n_robust = int(self.capacity * self.quota_robust)
        n_diverse = int(self.capacity * self.quota_diverse)
        n_explore = self.capacity - n_robust - n_diverse
        chosen: list[tuple[float, list[int], dict]] = []
        seen_keys: set[tuple[int, ...]] = set()

        def _take(item: tuple[float, list[int], dict]) -> bool:
            # 只按 tokens 精确去重。指标指纹是近似索引:碰撞不能证明两条
            # 时序等价(方案 §8.1),序列级确认发生在 selection_v2 的行为
            # 去重(有因子序列可比较),档案层不凭指纹丢候选。
            key = tuple(item[1])
            if key in seen_keys:
                return False
            seen_keys.add(key)
            chosen.append(item)
            return True

        # 1) 稳健区
        for item in pool:
            if len(chosen) >= n_robust:
                break
            if _robust_ok(item[2]):
                _take(item)
        # 2) 多样区:分组轮转(每族×复杂度×换手组取当前最优,循环)
        groups: dict[tuple, list[tuple[float, list[int], dict]]] = {}
        for item in pool:
            if tuple(item[1]) in seen_keys:
                continue
            groups.setdefault(group_key(item[1], item[2]), []).append(item)
        # 组内已按 pool 序(训练分降序);轮转取组首
        order = sorted(groups.items(), key=lambda kv: (-len(kv[1]), kv[0]))
        while len(chosen) < n_robust + n_diverse and any(g for _, g in order):
            progressed = False
            for gi, (_k, g) in enumerate(order):
                if not g:
                    continue
                if len(chosen) >= n_robust + n_diverse:
                    break
                item = g.pop(0)
                if _take(item):
                    progressed = True
            if not progressed:
                break
        # 3) 探索区:稳定哈希序(确定性,等价固定种子抽样)
        rest = [i for i in pool if tuple(i[1]) not in seen_keys]
        rest.sort(key=lambda i: _stable_hash(i[1]))
        for item in rest:
            if len(chosen) >= self.capacity:
                break
            _take(item)
        # 4) 空位回填:训练分降序补满(确定性规则)
        if len(chosen) < self.capacity:
            for item in pool:
                if len(chosen) >= self.capacity:
                    break
                key = tuple(item[1])
                if key not in seen_keys:
                    _take(item)
        return chosen

    def to_payload(self) -> list[dict]:
        return [
            {"composite": c, "tokens": t, "metrics": m} for c, t, m in self.snapshot()
        ]


@dataclass
class ValidationBudget:
    """整个运行累计的唯一验证候选上限(方案 §8.2)。

    重复读取验证结果会形成选择压力:预算全局计数,耗尽后调用方不得
    再把新候选送进严格筛(存量候选照常完成)。
    """

    limit: int = 60
    used: int = 0
    exposures: dict[str, int] = field(default_factory=dict)

    def spend(self, key: str = "default") -> bool:
        """记录一次验证暴露;返回是否仍在预算内。"""
        self.exposures[key] = self.exposures.get(key, 0) + 1
        if self.used < self.limit:
            self.used += 1
            return True
        return False

    @property
    def exhausted(self) -> bool:
        return self.used >= self.limit
