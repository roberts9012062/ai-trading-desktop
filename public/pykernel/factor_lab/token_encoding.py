"""因子 token 编码 —— 特征/算子 id 空间划分与版本迁移

token 布局：
    [0, MAX_FEATURES)              特征 id（对应 FEATURE_NAMES，未用满则留空）
    [MAX_FEATURES, MAX_FEATURES+O) 算子 id（对应 OPS_NAMES）

为什么要冻结 MAX_FEATURES：
v1 编码里 FEAT_OFFSET == len(FEATURE_NAMES) == 14，算子 id = 算子序号 + 14。
这意味着**每新增一个特征都会整体平移算子 id**，已持久化的 token
（factor_history / factor_favorites / ai_trading_tasks.strategy_params）
会被解码成完全不同的算子 —— 属于典型的脆弱性。

v2 把特征 id 空间冻结为固定 64，特征与算子从此可以各自独立增长，
新增特征不再触动算子 id，也不再需要第二次数据迁移。

v1 → v2 映射：特征 id 不变，算子 id 平移 (MAX_FEATURES - V1_FEAT_OFFSET)。
该映射是单射，因此不会让 tokens_key 唯一约束产生新冲突。
"""

from __future__ import annotations

# 特征 id 空间上限（冻结值，不可再改；改动会要求又一次数据迁移）
MAX_FEATURES = 64

# 算子 id 起点
FEAT_OFFSET = MAX_FEATURES

# 当前编码版本，与 system_settings.factor_token_encoding_version 对应
TOKEN_ENCODING_VERSION = 2

# v1 历史编码的算子起点
V1_FEAT_OFFSET = 14

_V1_TO_V2_SHIFT = MAX_FEATURES - V1_FEAT_OFFSET


def remap_v1_to_v2(tokens: list[int]) -> list[int]:
    """把 v1 token 序列重映射为 v2

    特征 id（< 14）保持不变，算子 id（>= 14）整体后移 50。
    纯函数，不修改入参。
    """
    return [
        token if token < V1_FEAT_OFFSET else token + _V1_TO_V2_SHIFT
        for token in tokens
    ]


def looks_like_v1(tokens: list[int], feature_count: int) -> bool:
    """序列是否含落在「特征空洞区」的 token —— v1 算子 id 的特征

    v2 下 [feature_count, MAX_FEATURES) 是特征空间的未使用部分，
    合法公式不会出现这些值；而部分 v1 算子 id 恰好落在其中。

    已知盲区：追加新特征后，[V1_FEAT_OFFSET, feature_count) 区间既可能是
    v1 算子，也可能是 v2 新特征，纯值域判断无法区分。该盲区不会导致误执行 ——
    误读的一元算子让终态栈深 +1、二元 +2，含 ≥1 个算子的合法 v1 后缀式
    终态栈深为 1，误读后必 ≥2，StackVM 直接判非法返回 None；纯特征公式
    （无算子）在两种编码下语义相同。即可识别的走本函数拦截，不可识别的
    走栈失衡失败，都不会算出错误因子值。

    权威判据始终是 system_settings.factor_token_encoding_version；
    本函数只作不查库的辅助拦截。
    """
    return any(feature_count <= token < MAX_FEATURES for token in tokens)
