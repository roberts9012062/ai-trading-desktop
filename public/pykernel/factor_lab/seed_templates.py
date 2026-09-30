"""因子族种子模板(crypto_local_v2,方案 §9.1 第一批)

第一批不改 v2 编码:用现有特征/算子生成短模板、不同符号方向、不同经济
解释的种子,先从现有能力获得收益。种子占初始种群约 20%~30%,其余保持
随机探索;同族/同结构去重,不让人工模板占满种群。

模板族(方案 §10 因子族的现有能力可达子集):
- A 波动调整动量:CRYPTO_MOM6/24 现成(短长动量差用 SUB 组合);
- A 流量压力:TAKER_IMBALANCE 平滑(现货真实主动买卖不平衡);
- A funding 拥挤:FUNDING_RATE/FUNDING_DELTA(最近已公布费率/结算间差分);
- A OI/价格四象限:OI_CHG×价格方向(期货特征,加密 Gate 渠道可用);
- B 尾部/跳跃:CRYPTO_TAIL20(负收益平方占比);
- B 成交规模:AVG_TRADE_QUOTE 平滑;
- 反转方向:每个动量模板配一个取反(经济方向成对探索,搜索自行淘汰)。

纪律:
- 全部 token 走现有编码(特征 <64,算子 ≥64);不新增 ID;
- 模板在注入前按 active 特征集过滤(数据不可用的族不注入);
- 注入是确定性的:同 seed 同候选,先于随机种群放置。
"""

from __future__ import annotations

from typing import Any

from .ops import OP_INDEX
from .token_encoding import FEAT_OFFSET

# 算子 id 从 OPS_CONFIG 的 OP_INDEX 编程式取得(顺序冻结,不手写数字)
OP = {name: idx + FEAT_OFFSET for name, idx in OP_INDEX.items()}

# 特征 id(append-only 冻结,见 features.py FEATURE_NAMES)
F = {
    "RET": 0, "RET5": 1, "RET20": 2, "VOL_RATIO": 11, "VOL_Z": 12,
    "OI_CHG": 15, "OI_PV": 16, "SKEW20": 32,
    "CRYPTO_MOM6": 45, "CRYPTO_MOM24": 46, "CRYPTO_VOL20": 47,
    "CRYPTO_ILLIQ20": 48, "CRYPTO_FLOW20": 49, "CRYPTO_TAIL20": 50,
    "CRYPTO_RANGE_POS20": 51,
    "FUNDING_RATE": 52, "FUNDING_DELTA": 53, "TAKER_IMBALANCE": 54,
    "QUOTE_ILLIQ20": 55, "ACCOUNT_LS_RATIO": 56,
    "LIQUIDATION_IMBALANCE": 57, "AVG_TRADE_QUOTE": 58,
}
def _tpl(family: str, tokens: list[int]) -> dict[str, Any]:
    return {"family": family, "tokens": tokens}


def seed_templates() -> list[dict[str, Any]]:
    """现有能力可达的因子族模板(短公式,方向成对)。

    每条模板是一个合法后缀 token 序列;经济方向与符号由模板自身给出,
    搜索按训练适应度淘汰。窗口只用现有算子的固定窗(5/10/20/60)。
    """
    t: list[dict[str, Any]] = []
    # ── A 波动调整动量(已有 CRYPTO_MOM6/24;补短长差与平滑变体)──
    t.append(_tpl("momentum", [F["CRYPTO_MOM6"]]))
    t.append(_tpl("momentum_rev", [F["CRYPTO_MOM6"], OP["NEG"]]))
    t.append(_tpl("momentum", [F["CRYPTO_MOM24"]]))
    t.append(_tpl("momentum_rev", [F["CRYPTO_MOM24"], OP["NEG"]]))
    t.append(_tpl("momentum_spread",
                  [F["CRYPTO_MOM6"], F["CRYPTO_MOM24"], OP["SUB"]]))
    t.append(_tpl("momentum_smooth", [F["CRYPTO_MOM6"], OP["TS_MA_10"]]))
    # ── A 流量压力(真实主动买卖不平衡;量权平滑)──
    t.append(_tpl("flow", [F["TAKER_IMBALANCE"], OP["TS_MA_20"]]))
    t.append(_tpl("flow_rev", [F["TAKER_IMBALANCE"], OP["TS_MA_20"], OP["NEG"]]))
    t.append(_tpl("flow", [F["TAKER_IMBALANCE"], OP["DECAY_LINEAR_20"]]))
    t.append(_tpl("flow_price_div",
                  [F["TAKER_IMBALANCE"], OP["TS_MA_10"], F["RET"], OP["TS_MA_10"], OP["CORR_20"], OP["NEG"]]))
    # ── A funding 拥挤(最近已公布费率/结算间差分)──
    t.append(_tpl("funding", [F["FUNDING_RATE"], OP["TS_MA_20"], OP["NEG"]]))
    t.append(_tpl("funding_carry", [F["FUNDING_RATE"], OP["TS_ZSCORE_20"], OP["NEG"]]))
    t.append(_tpl("funding_delta", [F["FUNDING_DELTA"], OP["TS_MA_10"]]))
    t.append(_tpl("funding_extreme", [F["FUNDING_RATE"], OP["TS_CRANK_20"], OP["NEG"]]))
    # ── A OI/价格四象限(增仓上涨/增仓下跌/减仓状态)──
    t.append(_tpl("oi_price", [F["OI_CHG"], F["RET"], OP["MUL"], OP["TS_MA_10"]]))
    t.append(_tpl("oi_price_rev", [F["OI_CHG"], F["RET"], OP["MUL"], OP["TS_MA_10"], OP["NEG"]]))
    t.append(_tpl("oi_confirm", [F["OI_PV"], OP["TS_MA_20"]]))
    # ── B 尾部/跳跃(负收益平方占比;有符号风险结构)──
    t.append(_tpl("tail", [F["CRYPTO_TAIL20"], OP["NEG"]]))
    t.append(_tpl("tail_state", [F["CRYPTO_TAIL20"], F["CRYPTO_MOM6"], OP["MUL"]]))
    # ── B 成交规模/流动性(Amihud 与单笔规模的偏离)──
    t.append(_tpl("liquidity", [F["CRYPTO_ILLIQ20"], OP["TS_ZSCORE_20"]]))
    t.append(_tpl("trade_size", [F["AVG_TRADE_QUOTE"], OP["TS_MA_20"], OP["NEG"]]))
    t.append(_tpl("liq_jump", [F["QUOTE_ILLIQ20"], OP["TS_CRANK_20"], OP["NEG"]]))
    # ── B 账户拥挤(多空比稳健偏离)──
    t.append(_tpl("crowding", [F["ACCOUNT_LS_RATIO"], OP["TS_ZSCORE_20"], OP["NEG"]]))
    t.append(_tpl("crowding_flow",
                  [F["ACCOUNT_LS_RATIO"], OP["TS_ZSCORE_20"], F["CRYPTO_MOM6"], OP["MUL"]]))
    # ── B 清算强度(多空清算差;状态交互)──
    t.append(_tpl("liquidation", [F["LIQUIDATION_IMBALANCE"], OP["TS_MA_10"]]))
    t.append(_tpl("liquidation_rev",
                  [F["LIQUIDATION_IMBALANCE"], OP["TS_MA_10"], OP["NEG"]]))
    # ── 区间位置反转/延续 ──
    t.append(_tpl("range_rev", [F["CRYPTO_RANGE_POS20"], OP["NEG"]]))
    t.append(_tpl("range_mom", [F["CRYPTO_RANGE_POS20"], F["CRYPTO_MOM6"], OP["MUL"]]))
    return t


# 短周期(≤15m)启用慢变体族的周期集合
_SLOW_TFS = {"1m", "5m", "15m"}


def slow_seed_templates() -> list[dict[str, Any]]:
    """慢变体族:同经济解释,但信号经长窗平滑(60 均值/20 线性衰减堆叠)。

    短周期单根毛边际 = IC×单根波动(1m≈0.10%、15m≈0.37%),成本固定
    6-10bp/回合——持仓几十根才回本。快模板几根就翻仓,净额适应度必负,
    种群在错误区域消耗预算;慢变体把初始探索引向低换手区域。方向对与
    经济解释与快速版一一对应,搜索按训练适应度淘汰。
    """
    t: list[dict[str, Any]] = []
    # ── 慢动量(长窗平滑动量及差)──
    t.append(_tpl("momentum", [F["CRYPTO_MOM24"], OP["TS_MA_60"]]))
    t.append(_tpl("momentum_rev", [F["CRYPTO_MOM24"], OP["TS_MA_60"], OP["NEG"]]))
    t.append(_tpl("momentum_spread",
                  [F["CRYPTO_MOM6"], OP["TS_MA_60"], F["CRYPTO_MOM24"], OP["TS_MA_60"], OP["SUB"]]))
    # ── 慢流量压力 ──
    t.append(_tpl("flow", [F["TAKER_IMBALANCE"], OP["TS_MA_60"]]))
    t.append(_tpl("flow_rev", [F["TAKER_IMBALANCE"], OP["TS_MA_60"], OP["NEG"]]))
    t.append(_tpl("flow", [F["TAKER_IMBALANCE"], OP["DECAY_LINEAR_20"], OP["TS_MA_60"]]))
    # ── 慢 funding 拥挤 ──
    t.append(_tpl("funding", [F["FUNDING_RATE"], OP["TS_MA_60"], OP["NEG"]]))
    t.append(_tpl("funding_carry", [F["FUNDING_RATE"], OP["TS_ZSCORE_120"], OP["NEG"]]))
    # ── 慢 OI/价格 ──
    t.append(_tpl("oi_confirm", [F["OI_PV"], OP["TS_MA_60"]]))
    t.append(_tpl("oi_price", [F["OI_CHG"], F["RET"], OP["MUL"], OP["TS_MA_60"]]))
    # ── 慢尾部/流动性/拥挤/清算 ──
    t.append(_tpl("tail", [F["CRYPTO_TAIL20"], OP["TS_MA_60"], OP["NEG"]]))
    t.append(_tpl("liquidity", [F["CRYPTO_ILLIQ20"], OP["TS_MA_60"]]))
    t.append(_tpl("crowding", [F["ACCOUNT_LS_RATIO"], OP["TS_MA_60"], OP["NEG"]]))
    t.append(_tpl("liquidation", [F["LIQUIDATION_IMBALANCE"], OP["TS_MA_60"]]))
    # ── 慢区间位置 ──
    t.append(_tpl("range_rev", [F["CRYPTO_RANGE_POS20"], OP["TS_MA_60"], OP["NEG"]]))
    return t


def templates_for(active_ids: list[int], timeframe: str = "") -> list[list[int]]:
    """按 active 特征集过滤模板(数据不可用的族不注入),返回 token 列表。

    同族去重:每族最多保留 2 条(方向对算 1 条结构),避免单族占满种子配额。
    短周期(≤15m)把慢变体族排在前面:配额内优先注入低换手结构,快速版
    仍保留在其后(探索多样性由训练适应度裁决)。
    """
    active = set(active_ids)
    by_family: dict[str, list[list[int]]] = {}
    for tpl in seed_templates():
        missing = [tok for tok in tpl["tokens"]
                   if tok < FEAT_OFFSET and tok not in active]
        if missing:
            continue
        by_family.setdefault(tpl["family"], []).append(tpl["tokens"])
    out: list[list[int]] = []
    if str(timeframe) in _SLOW_TFS:
        slow_by_family: dict[str, list[list[int]]] = {}
        for tpl in slow_seed_templates():
            missing = [tok for tok in tpl["tokens"]
                       if tok < FEAT_OFFSET and tok not in active]
            if missing:
                continue
            slow_by_family.setdefault(tpl["family"], []).append(tpl["tokens"])
        for fam in sorted(slow_by_family):
            out.extend(slow_by_family[fam][:2])
    for fam in sorted(by_family):
        out.extend(by_family[fam][:2])
    return out


def seed_fraction(population: int, templates: list | int) -> int:
    """种子占初始种群的 20%~30%(方案 §9.1);至少 1、至多 population-2。

    templates 传模板列表或其数量均可。"""
    n_templates = len(templates) if isinstance(templates, list) else int(templates)
    quota = max(1, min(n_templates, int(round(population * 0.25))))
    return min(quota, max(0, population - 2))
