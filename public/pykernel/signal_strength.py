"""强弱指标计算内核 —— 与前端 lib/strength-index.ts 逐位同源

0–100 归一化副图蜡烛 + 三档进场信号（swing/rebound/deep）。同一组 bars
两端必须得到逐位相同的结果，由 tests/test_signal_strength.py 与
frontend/src/lib/strength-index.test.mjs 共读 fixtures/strength_cases.json
守护。算法规格见 discuss/2026-08-31-强弱指标设计.md 第三节。

## 数值口径（与前端逐位一致的关键）

- 全程 float64 不做任何 round；仅在产出点/信号值时 half-up 保留 2 位
  （`math.floor(x*100+0.5)/100`，**勿用内置 round**——银行家舍入）。
- 趋势均线按「窗口左序求和后除以周期」独立实现（与前端同序浮点运算），
  不复用带 2 位舍入口径的既有 SMA 函数。
- 平滑表达式与前端逐字符对齐：`alpha * raw + (1 - alpha) * prev`。

## 结构

raw 位置归一化（窗口 HH/LL；range==0 取 50）→ 一次平滑（主序列递归，
open/high/low 复用同一上一状态）→ 二次平滑（同结构；smooth2=1 时 β=1
位级退化，无需特判）→ 三档信号（deep > rebound > swing，同档冷却，
高优先级档被冷却挡住时落到低优先级档判定）。

严格因果：只用 [0, i] 数据；序列末根视为形成中，其信号 pending=True
（未收盘确认，可能消失）；已收盘 bar 的信号永不撤销。
"""

from __future__ import annotations

import math
from typing import Any, TypedDict


class StrengthParams(TypedDict):
    period: int  # 归一化窗口（2-200），默认 14
    smooth: int  # 一次平滑周期（1-50），默认 3；1 = 不平滑
    smooth2: int  # 二次平滑周期（1-50），默认 1 = 关闭
    trend_ma_period: int  # 趋势均线周期（2-200），默认 10
    swing_threshold: float  # 波段进场阈值（0-100），默认 50
    rebound_threshold: float  # 反弹进场阈值（0-100），默认 50
    oversold_level: float  # 弱区判定线（0-50），默认 20
    rebound_lookback: int  # 反弹回溯窗口（1-100 根），默认 10
    deep_level: float  # 极低位判定线（0-30），默认 5
    deep_bars: int  # 极低位钝化最少根数（1-50），默认 3
    cooldown: int  # 同档信号最小间隔根数（0-200），默认 3


class StrengthPoint(TypedDict):
    time: str
    open: float
    high: float
    low: float
    close: float


class StrengthSignal(TypedDict):
    time: str
    index: int  # 触发 bar 在输入序列中的下标
    kind: str  # swing | rebound | deep
    value: float  # 触发时的强弱值（主序列，保留 2 位）
    pending: bool  # 末根（形成中）信号，未收盘确认


class StrengthResult(TypedDict):
    points: list[StrengthPoint]
    signals: list[StrengthSignal]


DEFAULT_STRENGTH_PARAMS = StrengthParams(
    period=14,
    smooth=3,
    smooth2=1,
    trend_ma_period=10,
    swing_threshold=50.0,
    rebound_threshold=50.0,
    oversold_level=20.0,
    rebound_lookback=10,
    deep_level=5.0,
    deep_bars=3,
    cooldown=3,
)

# 参数名别名表：camelCase（前端图表配置/fixture）与 snake_case（量化策略层）
# 双口径归一 —— 同一份默认值与 clamp 逻辑服务两端
_PARAM_KEYS: dict[str, str] = {
    "period": "period",
    "smooth": "smooth",
    "smooth2": "smooth2",
    "trendMaPeriod": "trend_ma_period",
    "trend_ma_period": "trend_ma_period",
    "swingThreshold": "swing_threshold",
    "swing_threshold": "swing_threshold",
    "reboundThreshold": "rebound_threshold",
    "rebound_threshold": "rebound_threshold",
    "oversoldLevel": "oversold_level",
    "oversold_level": "oversold_level",
    "reboundLookback": "rebound_lookback",
    "rebound_lookback": "rebound_lookback",
    "deepLevel": "deep_level",
    "deep_level": "deep_level",
    "deepBars": "deep_bars",
    "deep_bars": "deep_bars",
    "cooldown": "cooldown",
}


def normalize_strength_params(raw: dict[str, Any] | None) -> StrengthParams:
    """camelCase（前端/fixture 口径）→ snake_case；缺省回落默认值。

    供图表配置解析与量化策略层共用；未知键忽略，不抛错。
    """
    params = dict(DEFAULT_STRENGTH_PARAMS)
    if not raw:
        return params
    for camel, snake in _PARAM_KEYS.items():
        if camel in raw and raw[camel] is not None:
            params[snake] = raw[camel]  # type: ignore[literal-required]
    return params


def _round2(x: float) -> float:
    """half-up 保留 2 位（与前端 Math.round(x*100)/100 同口径）"""
    return math.floor(x * 100 + 0.5) / 100


def _sma_at(closes: list[float], i: int, period: int) -> float:
    """趋势均线：窗口内 close 自左向右求和后除以周期（与前端同序）"""
    total = 0.0
    for j in range(i - period + 1, i + 1):
        total += closes[j]
    return total / period


def calc_strength(bars: list[dict[str, Any]], params: StrengthParams) -> StrengthResult:
    """计算强弱指标。

    输出点取二次平滑序列（smooth2=1 时与一次平滑位级相同）；
    三档信号一律判定一次平滑主序列。
    """
    n = len(bars)
    first = params["period"] - 1
    if n <= first:
        return StrengthResult(points=[], signals=[])

    alpha = 1 / params["smooth"]
    beta = 1 / params["smooth2"]
    count = n - first

    s_close: list[float] = [0.0] * count
    p_close: list[float] = [0.0] * count
    points: list[StrengthPoint] = []

    for k in range(count):
        i = first + k
        bar = bars[i]
        # 归一化窗口 [i-period+1, i]：range==0（一字板/极端停滞）取 50
        hh = -math.inf
        ll = math.inf
        for j in range(i - params["period"] + 1, i + 1):
            if bars[j]["high"] > hh:
                hh = bars[j]["high"]
            if bars[j]["low"] < ll:
                ll = bars[j]["low"]
        price_range = hh - ll
        if price_range == 0:
            raw_close = 50.0
            raw_high = 50.0
            raw_low = 50.0
            raw_open = 50.0
        else:
            raw_close = ((bar["close"] - ll) / price_range) * 100
            raw_high = ((bar["high"] - ll) / price_range) * 100
            raw_low = ((bar["low"] - ll) / price_range) * 100
            raw_open = ((bar["open"] - ll) / price_range) * 100

        # 一次平滑：主序列递归；open/high/low 复用同一个上一状态 S[i-1]
        if k == 0:
            s_c = raw_close
            s_h = raw_high
            s_l = raw_low
        else:
            prev = s_close[k - 1]
            s_c = alpha * raw_close + (1 - alpha) * prev
            s_h = alpha * raw_high + (1 - alpha) * prev
            s_l = alpha * raw_low + (1 - alpha) * prev
        s_close[k] = s_c

        # 二次平滑：同结构再走一遍；首根直接承接一次平滑值
        if k == 0:
            p_c = s_c
            p_h = s_h
            p_l = s_l
            points.append(
                StrengthPoint(
                    time=bar["time"],
                    open=_round2(raw_open),
                    high=_round2(p_h),
                    low=_round2(p_l),
                    close=_round2(p_c),
                )
            )
        else:
            prev_p = p_close[k - 1]
            p_c = beta * s_c + (1 - beta) * prev_p
            p_h = beta * s_h + (1 - beta) * prev_p
            p_l = beta * s_l + (1 - beta) * prev_p
            # 蜡烛连续：open[i] = 二次平滑 close[i-1]
            points.append(
                StrengthPoint(
                    time=bar["time"],
                    open=_round2(prev_p),
                    high=_round2(p_h),
                    low=_round2(p_l),
                    close=_round2(p_c),
                )
            )
        p_close[k] = p_c

    # 三档信号：deep > rebound > swing，同根只出最强一档；
    # 高优先级档被冷却挡住时按伪代码落到低优先级档判定（discuss 3.4）
    signals: list[StrengthSignal] = []
    last_deep = -math.inf
    last_rebound = -math.inf
    last_swing = -math.inf
    closes = [float(b["close"]) for b in bars]

    for k in range(1, count):
        i = first + k
        s_prev = s_close[k - 1]
        s_cur = s_close[k]

        # deep：极低位钝化后首次拐头（S[i] 本身允许仍 ≤ deepLevel）
        deep_hit = False
        if k >= params["deep_bars"] and s_cur > s_prev:
            deep_hit = True
            for d in range(1, params["deep_bars"] + 1):
                if s_close[k - d] > params["deep_level"]:
                    deep_hit = False
                    break

        # rebound：近期到过弱区 + 回升上穿阈值
        rebound_hit = False
        if k >= params["rebound_lookback"]:
            for j in range(k - params["rebound_lookback"], k):
                if s_close[j] <= params["oversold_level"]:
                    rebound_hit = True
                    break
            rebound_hit = (
                rebound_hit
                and s_prev < params["rebound_threshold"]
                and s_cur >= params["rebound_threshold"]
            )

        # swing：上穿阈值 + 主图多头（close > SMA）
        swing_hit = False
        if i >= params["trend_ma_period"] - 1:
            swing_hit = (
                s_prev < params["swing_threshold"]
                and s_cur >= params["swing_threshold"]
                and closes[i] > _sma_at(closes, i, params["trend_ma_period"])
            )

        pending = i == n - 1
        if deep_hit and i - last_deep >= params["cooldown"]:
            signals.append(
                StrengthSignal(time=bars[i]["time"], index=i, kind="deep", value=_round2(s_cur), pending=pending)
            )
            last_deep = i
            continue
        if rebound_hit and i - last_rebound >= params["cooldown"]:
            signals.append(
                StrengthSignal(time=bars[i]["time"], index=i, kind="rebound", value=_round2(s_cur), pending=pending)
            )
            last_rebound = i
            continue
        if swing_hit and i - last_swing >= params["cooldown"]:
            signals.append(
                StrengthSignal(time=bars[i]["time"], index=i, kind="swing", value=_round2(s_cur), pending=pending)
            )
            last_swing = i

    return StrengthResult(points=points, signals=signals)
