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
    # 扩容批次2续/3/4（与桌面端 pykernel 对齐，id 40-50）
    "TS_CRANK_20": "20周期中心分位",
    "TS_CRANK_60": "60周期中心分位",
    "DECAY_LINEAR_10": "10周期线性衰减",
    "DECAY_LINEAR_20": "20周期线性衰减",
    "ROBUST_ZSCORE_20": "20周期稳健Z值",
    "WINSOR_20": "20周期缩尾",
    "VOL_SCALE_20": "20周期波动缩放",
    "SNR_20": "20周期信噪比",
    "SNR_60": "60周期信噪比",
    "TS_ZSCORE_120": "120周期Z值",
    "DELTA_24": "24阶差分",
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
    # 服务端独有特征（图表强弱指标主值同口径，桌面端 pykernel 无此项）——
    # P2-12 守卫测试 test_express_text_coverage 抓到的漏配
    "STRENGTH": "强弱值",
    # ── 扩容批次4（A 级纯 OHLCV + 加密日历）──
    "MACD": "MACD",
    "ADX14": "趋势强度ADX",
    "DONCH20": "唐奇安位置",
    "PARKINSON20": "区间波动",
    "GK20": "四价波动",
    "SEMIVOL20": "下行波动比",
    "VOV20": "波动不稳度",
    "JUMP20": "跳变频率",
    "VWAP_DEV20": "VWAP偏离",
    "AMIHUD20": "非流动性",
    "MFI14": "资金流量MFI",
    "CMF20": "Chaikin资金流",
    "TOD24": "日内时钟24",
    "US_SESSION": "美盘时段",
    "WEEKEND": "周末标记",
    # ── 扩容批次5（B 级衍生品 + P4 跨资产）──
    "FUNDING": "资金费率",
    "BTC_RET": "BTC收益",
    "EXCESS_RET": "超额收益",
    # ── 扩容批次6（B 级补齐：情绪/流向/跨所）──
    "LSR": "多空比",
    "TAKER": "主动买占比",
    "XSPREAD": "跨所价差",
    # ── v3 桌面端谱系特征（id 57-82；与桌面端 pykernel 同名同义）──
    "STREAK": "连涨连跌",
    "VWAP_DEV": "VWAP乖离",
    "UPDOWN_VOL_RATIO": "上下行量比",
    "CHAN_POS": "通道位置",
    "UTC_HOUR_SIN": "日内相位正弦",
    "UTC_HOUR_COS": "日内相位余弦",
    "UTC_WEEK_SIN": "周相位正弦",
    "UTC_WEEK_COS": "周相位余弦",
    "UTC_WEEKEND": "周末相位",
    "CRYPTO_MOM6": "6根动量",
    "CRYPTO_MOM24": "24根动量",
    "CRYPTO_VOL20": "20根波动",
    "CRYPTO_ILLIQ20": "20根非流动性",
    "CRYPTO_FLOW20": "20根资金流",
    "CRYPTO_TAIL20": "20根尾部收益",
    "CRYPTO_RANGE_POS20": "20根区间位置",
    "FUNDING_RATE": "资金费率原值",
    "FUNDING_DELTA": "资金费率变化",
    "TAKER_IMBALANCE": "主动买卖失衡",
    "QUOTE_ILLIQ20": "逐笔非流动性",
    "ACCOUNT_LS_RATIO": "账户多空比",
    "LIQUIDATION_IMBALANCE": "多空强平失衡",
    "AVG_TRADE_QUOTE": "单笔均额",
    "FUNDING_MEAN24": "24根资金费率均值",
    "OI_TREND24": "24根持仓趋势",
    "TAKER_IMB24": "24根主动买卖失衡",
}


def _feat_text(token: int, v3: bool = False) -> str:
    from .token_encoding import V2_FEATURE_COUNT

    limit = len(FEATURE_NAMES) if v3 else V2_FEATURE_COUNT
    name = FEATURE_NAMES[token] if token < limit else f"特征{token}"
    return _FEAT_TEXT.get(name, name)


def to_text(tokens: list[int]) -> str:
    """token 序列转中文可读表达式（自动识别 v3 编码）"""
    from .token_encoding import V3_FEAT_OFFSET, is_v3_tokens

    v3 = is_v3_tokens(tokens)
    feat_offset = V3_FEAT_OFFSET if v3 else FEAT_OFFSET
    stack: list[str] = []
    for token in tokens:
        token = int(token)
        if token < feat_offset:
            stack.append(_feat_text(token, v3=v3))
            continue
        idx = token - feat_offset
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
