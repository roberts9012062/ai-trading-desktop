/**
 * 强弱策略（V1 进场 / V2 形态档）的参数解析、组装与校验
 *
 * 自 lib/quant-strategy.ts 拆出（该文件守住 300 行上限），主文件在各
 * switch case 中调用本模块导出的片段；类型 QuantParamsState 自主文件
 * type-only 导入（运行时无环）。字段口径与后端 strategy_params 的
 * snake_case 一一对应（services/signal_strength*.py 双口径归一）。
 */

import type { QuantParamsState } from "./quant-strategy"

/** paramsToQuantState 内部的数值读取闭包（缺失/非法回落默认） */
export type QuantNumFn = (key: string, fb: number) => number

/** V1 强弱进场：strategy_params → 表单状态 */
export function parseStrengthParams(n: QuantNumFn): Partial<QuantParamsState> {
  return {
    strengthPeriod: n("period", 14), strengthSmooth: n("smooth", 3),
    strengthSmooth2: n("smooth2", 1), strengthTrendMa: n("trend_ma_period", 10),
    strengthSwingTh: n("swing_threshold", 50), strengthReboundTh: n("rebound_threshold", 50),
    strengthOversold: n("oversold_level", 20), strengthLookback: n("rebound_lookback", 10),
    strengthDeepLevel: n("deep_level", 5), strengthDeepBars: n("deep_bars", 3),
    strengthCooldown: n("cooldown", 3), strengthExit: n("exit_threshold", 50),
  }
}

/** V1 强弱进场：表单状态 → strategy_params */
export function buildStrengthParams(q: QuantParamsState): Record<string, unknown> {
  return {
    period: q.strengthPeriod, smooth: q.strengthSmooth, smooth2: q.strengthSmooth2,
    trend_ma_period: q.strengthTrendMa, swing_threshold: q.strengthSwingTh,
    rebound_threshold: q.strengthReboundTh, oversold_level: q.strengthOversold,
    rebound_lookback: q.strengthLookback, deep_level: q.strengthDeepLevel,
    deep_bars: q.strengthDeepBars, cooldown: q.strengthCooldown,
    exit_threshold: q.strengthExit,
  }
}

/** V2 强弱形态（六档双向）：strategy_params → 表单状态（sv2* 独立字段，默认与图表副图一致） */
export function parseStrengthV2Params(n: QuantNumFn): Partial<QuantParamsState> {
  return {
    sv2Period: n("period", 14), sv2Smooth: n("smooth", 3), sv2Smooth2: n("smooth2", 2),
    sv2Band: n("continuation_band", 5), sv2ExhaustWin: n("exhaust_window", 4),
    sv2ShrinkRatio: n("shrink_ratio", 0.45), sv2FlatEps: n("flat_eps", 1.2),
    sv2ZoneDrop: n("zone_drop", 10), sv2BufMult: n("price_buffer_atr_mult", 0.3),
    sv2AtrPeriod: n("atr_period", 14), sv2Cooldown: n("cooldown", 8),
  }
}

/** V2 强弱形态：表单状态 → strategy_params */
export function buildStrengthV2Params(q: QuantParamsState): Record<string, unknown> {
  return {
    period: q.sv2Period, smooth: q.sv2Smooth, smooth2: q.sv2Smooth2,
    continuation_band: q.sv2Band, exhaust_window: q.sv2ExhaustWin,
    shrink_ratio: q.sv2ShrinkRatio, flat_eps: q.sv2FlatEps,
    zone_drop: q.sv2ZoneDrop, price_buffer_atr_mult: q.sv2BufMult,
    atr_period: q.sv2AtrPeriod, cooldown: q.sv2Cooldown,
  }
}

/** 强弱两代共用校验；通过返回 null，失败返回错误文案 */
export function validateStrengthParams(q: QuantParamsState): string | null {
  if (q.quantKind === "strength_entry" && (q.strengthPeriod < 2 || q.strengthTrendMa < 2)) {
    return "强弱：归一化窗口与趋势均线周期须 ≥ 2"
  }
  if (q.quantKind === "strength_entry_v2" && (q.sv2Period < 2 || q.sv2AtrPeriod < 2)) {
    return "强弱V2：归一化窗口与 ATR 周期须 ≥ 2"
  }
  return null
}
