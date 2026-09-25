"""token 序列 ↔ 中文可读表达式"""

from __future__ import annotations

from .features import FEATURE_NAMES
from .ops import OPS_CONFIG
from .vm import FEAT_OFFSET

# 算子中文文案（二元显示为中缀，一元为函数式）
_OP_TEXT: dict[str, str] = {
    "ADD": "+",
    "SUB": "-",
    "MUL": "×",
    "DIV": "÷",
    "MIN": "取小",
    "MAX": "取大",
    "ABS": "绝对值",
    "NEG": "相反数",
    "SIGN": "符号",
    "SQRT": "开方",
    "SIGNED_LOG": "对数",
    "SIGMOID": "S型",
    "TANH": "压缩",
    "TS_MA_5": "5周期均值",
    "TS_MA_10": "10周期均值",
    "TS_MA_20": "20周期均值",
    "TS_STD_10": "10周期标准差",
    "TS_STD_20": "20周期标准差",
    "TS_MAX_10": "10周期最高",
    "TS_MAX_20": "20周期最高",
    "TS_MIN_10": "10周期最低",
    "TS_RANK_10": "10周期分位",
    "TS_RANK_20": "20周期分位",
    "TS_ZSCORE_20": "20周期Z值",
    "DELTA_1": "一阶差分",
    "DELTA_5": "五阶差分",
    "TS_ATR_NORM": "波动对数",
    # 扩容批次1/2(P2-12 补齐:此前缺失会在公式里露出英文名)
    "LAG_1": "滞后1根",
    "LAG_5": "滞后5根",
    "CORR_20": "20周期相关",
    "TS_MA_60": "60周期均值",
    "TS_STD_60": "60周期标准差",
    "TS_ZSCORE_60": "60周期Z值",
    "TS_RANK_60": "60周期分位",
    "TS_DEMEAN_20": "20周期去均值",
    "BETA_20": "20周期Beta",
    "RESID_20": "20周期残差",
    "STEP": "阶跃",
    "EMA_5": "5周期EMA",
    "EMA_20": "20周期EMA",
    "TS_CRANK_20": "20周期中心秩", "TS_CRANK_60": "60周期中心秩",
    "DECAY_LINEAR_10": "10周期线性衰减", "DECAY_LINEAR_20": "20周期线性衰减",
}

# 中文特征名
_FEAT_TEXT: dict[str, str] = {
    "RET": "当日收益",
    "RET5": "5日收益",
    "RET20": "20日收益",
    "MA_DIFF": "均线偏离",
    "SLOPE20": "均线斜率",
    "ATR14": "ATR波动",
    "RVOL": "量能波动",
    "HL_RANGE": "振幅",
    "DEV": "布林位置",
    "RSI14": "RSI",
    "AC1": "收益自相关",
    "VOL_RATIO": "量比",
    "VOL_Z": "量能Z值",
    "PV_CORR": "量价相关",
    "OI_CHG": "持仓变化",
    "OI_PV": "仓量价配合",
    "VOL_OI": "成交持仓比",
    "TOD": "日内时点",
    "NIGHT": "夜盘",
    # 扩容批次1/2(P2-12 补齐)
    "GAP": "跳空",
    "CLOSE_POS": "收盘位置",
    "UPPER_SHADOW": "上影线",
    "LOWER_SHADOW": "下影线",
    "BODY": "实体",
    "RET60": "60日收益",
    "MA_DIFF60": "60均线偏离",
    "VOLAT_RATIO": "波动比",
    "OI_PC": "持仓变化率",
    "OI_CHG5": "5日持仓变化",
    "OI_CHG20": "20日持仓变化",
    "VOL_OI_MA": "量仓均线比",
    "SKEW20": "20日偏度",
    "KURT20": "20日峰度",
    "DOW": "星期几",
    "DOM": "月中日",
    # 扩容批次3(服务端图表强弱指标主值同口径)——P2-12 守卫曾抓到的服务端漏配
    "STRENGTH": "强弱值",
    # 桌面端本地专属批次(id 36-39):服务端无此特征,仅本地可执行
    "STREAK": "连涨连跌",
    "VWAP_DEV": "量价偏离",
    "UPDOWN_VOL_RATIO": "涨跌波动比",
    "CHAN_POS": "通道位置",
    "UTC_HOUR_SIN": "UTC时钟正弦", "UTC_HOUR_COS": "UTC时钟余弦",
    "UTC_WEEK_SIN": "UTC星期正弦", "UTC_WEEK_COS": "UTC星期余弦", "UTC_WEEKEND": "UTC周末",
    "CRYPTO_MOM6": "6根波动调整动量", "CRYPTO_MOM24": "24根波动调整动量",
    "CRYPTO_VOL20": "20根收益波动", "CRYPTO_ILLIQ20": "20根非流动性代理",
    "CRYPTO_FLOW20": "20根方向成交量代理", "CRYPTO_TAIL20": "20根下行风险占比",
    "CRYPTO_RANGE_POS20": "20根加密通道位置",
}


def _feat_text(token: int) -> str:
    name = FEATURE_NAMES[token] if token < len(FEATURE_NAMES) else f"特征{token}"
    return _FEAT_TEXT.get(name, name)


def to_text(tokens: list[int]) -> str:
    """token 序列转中文可读表达式"""
    stack: list[str] = []
    for token in tokens:
        token = int(token)
        if token < FEAT_OFFSET:
            stack.append(_feat_text(token))
            continue
        idx = token - FEAT_OFFSET
        if idx < 0 or idx >= len(OPS_CONFIG):
            return "无效公式"
        name, _, arity = OPS_CONFIG[idx]
        if len(stack) < arity:
            return "无效公式"
        args = [stack.pop() for _ in range(arity)]
        args.reverse()
        txt = _OP_TEXT.get(name, name)
        if arity == 1:
            stack.append(f"{txt}({args[0]})")
        elif arity == 2 and txt in ("+", "-", "×", "÷"):
            stack.append(f"({args[0]} {txt} {args[1]})")
        else:
            stack.append(f"{txt}({', '.join(args)})")
    return stack[-1] if len(stack) == 1 else "无效公式"
