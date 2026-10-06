"""特征矩阵与按段缓存 —— bars_signature / feature_matrix / LRU 预算

自单文件 features.py 拆出（2026-08-31，行为零变化）。

── 特征矩阵按段缓存 ──────────────────────────────────────────
feature_matrix 只取决于 bars，但调用方按「候选因子 × 段」组织循环，
同一个段会被不同 tokens 反复重算。walk_forward 的段级缓存键含 tokens，
拦不住这层重复：实测一次超级因子挖掘任务（pop=40 × gen=30、2000 根日线）
调用 feature_matrix 330 次而只有 12 个不同段（27.5× 冗余），且它占单次
冷段评估耗时的 99%。按段缓存后 search_stepwise 由 49.5s 降到 1.1s，
冠军 tokens 与 composite 逐位一致——纯计算复用，无语义变化。

上限按元素数而非条目数计：段长跨度大（日线数千根、walk-forward 各折
训练段逐折增长），条目数上限约束不住内存。4M 元素 ≈ 32MB float64——
实测一次 2000 根日线挖掘只占 12 条 / 24.9 万元素（约 2MB），预算只在
超深数据上才收紧；上限取保守值是因为同一份内核也跑在桌面端 Pyodide 里
（浏览器堆更紧，且缓存驻留与该处的代际回收诉求相抵）。

实盘因子策略（ai_trading）每 2 秒按最新 bars 求一次信号，末根一变签名
即变，基本恒为未命中——它只付一次字典查找的代价，并会挤占缓存。挖掘
侧不受影响：挖掘每代都重复命中自己那十几个段，LRU 次序被持续刷新，
驻留优先级高于只写一次的实盘条目；最坏情况也只是 32MB 上限内的浪费。
"""

from __future__ import annotations

from collections import OrderedDict
import hashlib
from typing import Any

import numpy as np

from .compute import FEATURE_NAMES, compute_features

_MATRIX_CACHE: OrderedDict[tuple, np.ndarray] = OrderedDict()
_MATRIX_CACHE_MAX_ELEMENTS = 4_000_000


def bars_signature(bars: list[dict[str, Any]]) -> tuple:
    """Hash every feature input; revisions anywhere in a segment invalidate it."""
    if not bars:
        return (0,)
    digest = hashlib.sha256()
    keys = ("time","open","high","low","close","volume","open_interest",
            "funding_rate","lsr","taker_ratio","xspread","btc_ret",
            "_factor_market","quote_volume","trade_count","taker_buy_volume",
            "long_short_ratio","taker_imbalance","liquidation_imbalance")
    for bar in bars:
        digest.update(repr(tuple(bar.get(k) for k in keys)).encode("utf-8"))
    return (len(bars), digest.digest())


def _evict_matrix_cache() -> None:
    """按元素预算淘汰最久未用的段（至少保留刚写入的一条）"""
    total = sum(int(m.size) for m in _MATRIX_CACHE.values())
    while len(_MATRIX_CACHE) > 1 and total > _MATRIX_CACHE_MAX_ELEMENTS:
        _, dropped = _MATRIX_CACHE.popitem(last=False)
        total -= int(dropped.size)


def clear_feature_matrix_cache() -> None:
    """清空特征矩阵缓存（测试隔离用）"""
    _MATRIX_CACHE.clear()


def feature_matrix(bars: list[dict[str, Any]], *, normalization_window: int | None = None) -> np.ndarray:
    """返回 [F, T] 特征矩阵，顺序与 FEATURE_NAMES 一致

    结果按段缓存，返回只读数组（调用方只按行取特征送入 StackVM，
    不写入矩阵；只读标记把将来的意外写入变成显式报错而非静默串数据）。
    """
    signature = bars_signature(bars)
    key = signature if normalization_window is None else (signature, normalization_window)
    hit = _MATRIX_CACHE.get(key)
    if hit is not None:
        _MATRIX_CACHE.move_to_end(key)
        return hit
    feats = compute_features(bars, normalization_window=normalization_window)
    matrix = np.vstack([feats[name] for name in FEATURE_NAMES])
    matrix.flags.writeable = False
    _MATRIX_CACHE[key] = matrix
    _MATRIX_CACHE.move_to_end(key)
    _evict_matrix_cache()
    return matrix
