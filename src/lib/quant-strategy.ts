/** 量化策略类型与参数构造（回测 / 实时任务共用） */

export type QuantKind =
  | "n_breakout"
  | "ma_cross"
  | "macd_cross"
  | "kdj_cross"
  | "band_swing"
  | "swing_pivot"
  | "swing_pivot_v2"
  | "strength_entry"
  | "strength_entry_v2"
  | "factor"

export interface QuantParamsState {
  quantKind: QuantKind
  // 双均线
  fastPeriod: number
  slowPeriod: number
  // N 日突破
  lookback: number
  // MACD
  macdFast: number
  macdSlow: number
  macdSignal: number
  // KDJ
  kdjN: number
  kdjK: number
  kdjD: number
  kdjUseZone: boolean
  // 布林波段
  bandPeriod: number
  bandStd: number
  // 枢轴波段（价格高低点 Fractal 反转，V1）
  swingLeft: number
  swingRight: number
  /** 盘中预确认最少右侧根数（1–swingRight，与图表波段信号同口径，默认 1） */
  swingMinRightLive: number
  swingMinAmplitude: number
  swingMinAtrMult: number
  swingAtrPeriod: number
  /** 信号新鲜度窗口（根）：信号须出现在最近 N 根内才开仓/反向平仓，默认 3 */
  swingMaxAge: number
  /** 第二周期（如 15m；空 = 单周期不共振） */
  swingResonanceTf: string
  /** 开仓模式 single=主周期信号即下单 / resonance=双周期同向新鲜信号 */
  swingEntryMode: string
  /** 反向信号平仓模式 single / resonance */
  swingExitMode: string
  /** 信号K线止损 off=关 / single=主周期信号K线极值 / resonance=第二周期极值 */
  swingStopMode: string
  /** 止损线在信号K线极值外追加的点数（0-5） */
  swingStopBuffer: number
  /** 信号K线止损后自动反手（平仓同时开反向仓） */
  swingReverseOnStop: boolean
  /** 反手仓止损百分比（以反手成交价为基准，0.1-10；0=用信号K线另一侧极值） */
  swingReverseStopPct: number
  // 枢轴波段 V2 专属：前期高低点 + 量价拒绝形态（left/right/atr 与 V1 共用）
  swingProximity: number
  swingWickMult: number
  swingAttackWindow: number
  swingVolExpand: number
  swingVolShrink: number
  swingVolMaPeriod: number
  swingCooldown: number
  // 强弱进场（0-100 强弱指标三档进场做多，与图表副图同口径）
  strengthPeriod: number; strengthSmooth: number; strengthSmooth2: number
  strengthTrendMa: number; strengthSwingTh: number; strengthReboundTh: number
  strengthOversold: number; strengthLookback: number; strengthDeepLevel: number
  strengthDeepBars: number; strengthCooldown: number
  strengthExit: number // 平多阈值（强弱收盘值跌破即离场）
  // 强弱形态 V2（六档双向；sv2* 独立字段，默认与图表 V2 副图同口径，smooth2=2）
  sv2Period: number; sv2Smooth: number; sv2Smooth2: number; sv2Band: number
  sv2ExhaustWin: number; sv2ShrinkRatio: number; sv2FlatEps: number
  sv2ZoneDrop: number; sv2BufMult: number; sv2AtrPeriod: number; sv2Cooldown: number
  // 因子公式（逗号分隔的 token 序列，来自因子实验室）
  factorTokensText: string
  /** 因子开仓线（|因子仓位| 越线才开仓，默认 0.3，0.05-0.5） */
  factorEntry: string
}

export const DEFAULT_QUANT_PARAMS: QuantParamsState = {
  quantKind: "n_breakout",
  fastPeriod: 5,
  slowPeriod: 20,
  lookback: 20,
  macdFast: 12,
  macdSlow: 26,
  macdSignal: 9,
  kdjN: 9,
  kdjK: 3,
  kdjD: 3,
  kdjUseZone: false,
  bandPeriod: 20,
  bandStd: 2,
  swingLeft: 3,
  swingRight: 3,
  swingMinRightLive: 1,
  swingMinAmplitude: 1.5,
  swingMinAtrMult: 1.5,
  swingAtrPeriod: 14,
  swingMaxAge: 3,
  swingResonanceTf: "",
  swingEntryMode: "single",
  swingExitMode: "single",
  swingStopMode: "off",
  swingStopBuffer: 0,
  swingReverseOnStop: false,
  swingReverseStopPct: 0,
  swingProximity: 1.0, swingWickMult: 0.8, swingAttackWindow: 3,
  swingVolExpand: 1.5, swingVolShrink: 0.7, swingVolMaPeriod: 20, swingCooldown: 5,
  strengthPeriod: 14, strengthSmooth: 3, strengthSmooth2: 1, strengthTrendMa: 10,
  strengthSwingTh: 50, strengthReboundTh: 50, strengthOversold: 20,
  strengthLookback: 10, strengthDeepLevel: 5, strengthDeepBars: 3,
  strengthCooldown: 3, strengthExit: 50,
  sv2Period: 14, sv2Smooth: 3, sv2Smooth2: 2, sv2Band: 5, sv2ExhaustWin: 4,
  sv2ShrinkRatio: 0.45, sv2FlatEps: 1.2, sv2ZoneDrop: 10, sv2BufMult: 0.3,
  sv2AtrPeriod: 14, sv2Cooldown: 8,
  factorTokensText: "",
  factorEntry: "",
}

export const QUANT_KIND_OPTIONS: Array<{
  value: QuantKind
  label: string
  /** true = 暂停使用（按钮灰显不可选；存量任务编辑不受影响） */
  disabled?: boolean
}> = [
  { value: "n_breakout", label: "N 日突破" },
  { value: "ma_cross", label: "双均线" },
  { value: "macd_cross", label: "MACD 金叉死叉" },
  { value: "kdj_cross", label: "KDJ 金叉死叉" },
  { value: "band_swing", label: "布林带波段" },
  { value: "swing_pivot", label: "枢轴波段" },
  // 2026-08-31 暂停：V2 量价拒绝经实盘复盘判定信号不达标，入口灰显不可选
  { value: "swing_pivot_v2", label: "枢轴波段 V2（暂停使用）", disabled: true },
  { value: "strength_entry", label: "强弱进场" },
  { value: "strength_entry_v2", label: "强弱形态 V2（双向）" },
  { value: "factor", label: "因子公式" },
]

import { buildStrengthParams, buildStrengthV2Params, parseStrengthParams, parseStrengthV2Params, validateStrengthParams } from "./quant-strategy-strength"

/** 解析因子 tokens 文本为整数列表 */
export function parseFactorTokens(text: string): number[] {
  return text
    .split(/[,，\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => Number(s))
    .filter((n) => Number.isInteger(n))
    .map((n) => Math.trunc(n))
}

/**
 * 后端 strategy_params（平铺）→ 表单状态，buildStrategyParams 的逆操作。
 * 用于编辑回填（如 AI 参考策略从任务 strategy_params 还原参数表单）。
 * 缺失/非法值回落到默认参数。
 */
export function paramsToQuantState(
  kind: QuantKind,
  params: Record<string, unknown> | null | undefined,
): QuantParamsState {
  const base: QuantParamsState = { ...DEFAULT_QUANT_PARAMS, quantKind: kind }
  const p = params ?? {}
  const n = (key: string, fb: number): number => {
    const v = p[key]
    return typeof v === "number" && Number.isFinite(v) ? v : fb
  }
  switch (kind) {
    case "ma_cross":
      return { ...base, fastPeriod: n("fast_period", 5), slowPeriod: n("slow_period", 20) }
    case "n_breakout":
      return { ...base, lookback: n("lookback", 20) }
    case "macd_cross":
      return {
        ...base,
        macdFast: n("fast_period", 12),
        macdSlow: n("slow_period", 26),
        macdSignal: n("signal_period", 9),
      }
    case "kdj_cross":
      return {
        ...base,
        kdjN: n("n_period", 9),
        kdjK: n("k_period", 3),
        kdjD: n("d_period", 3),
        kdjUseZone: p.use_zone === true,
      }
    case "factor":
      return {
        ...base,
        factorTokensText: Array.isArray(p.factor_tokens)
          ? (p.factor_tokens as unknown[]).join(",")
          : "",
        factorEntry:
          typeof p.entry_threshold === "number" && p.entry_threshold !== 0.3
            ? String(p.entry_threshold)
            : "",
      }
    case "band_swing":
      return { ...base, bandPeriod: n("period", 20), bandStd: n("std_mult", 2) }
    case "swing_pivot":
      return {
        ...base,
        swingLeft: n("left", 3),
        swingRight: n("right", 3),
        swingMinRightLive: n("min_right_live", 1),
        swingMinAmplitude: n("min_amplitude_pct", 1.5),
        swingMinAtrMult: n("min_atr_mult", 1.5),
        swingAtrPeriod: n("atr_period", 14),
        swingMaxAge: n("signal_max_age", 3),
        swingResonanceTf:
          typeof p.resonance_tf === "string" ? p.resonance_tf : "",
        swingEntryMode:
          p.entry_mode === "resonance" ? "resonance" : "single",
        swingExitMode: p.exit_mode === "resonance" ? "resonance" : "single",
        swingStopMode:
          p.stop_mode === "single" || p.stop_mode === "resonance"
            ? p.stop_mode
            : "off",
        swingStopBuffer: n("stop_buffer_points", 0),
        swingReverseOnStop: p.reverse_on_stop === true,
        swingReverseStopPct: n("reverse_stop_pct", 0),
      }
    case "swing_pivot_v2":
      return {
        ...base,
        swingLeft: n("left", 3),
        swingRight: n("right", 3),
        swingProximity: n("proximity_atr_mult", 1.0),
        swingWickMult: n("wick_atr_mult", 0.8),
        swingAttackWindow: n("attack_window", 3),
        swingVolExpand: n("vol_expand_ratio", 1.5),
        swingVolShrink: n("vol_shrink_ratio", 0.7),
        swingVolMaPeriod: n("vol_ma_period", 20),
        swingCooldown: n("cooldown", 5),
        swingAtrPeriod: n("atr_period", 14),
      }
    case "strength_entry":
      return { ...base, ...parseStrengthParams(n) }
    case "strength_entry_v2":
      return { ...base, ...parseStrengthV2Params(n) }
    default:
      return base
  }
}

/** 组装后端 strategy_params */
export function buildStrategyParams(
  q: QuantParamsState,
): Record<string, unknown> {
  switch (q.quantKind) {
    case "ma_cross":
      return {
        fast_period: q.fastPeriod,
        slow_period: q.slowPeriod,
        ma_type: "sma",
      }
    case "n_breakout":
      return { lookback: q.lookback }
    case "macd_cross":
      return {
        fast_period: q.macdFast,
        slow_period: q.macdSlow,
        signal_period: q.macdSignal,
      }
    case "kdj_cross":
      return {
        n_period: q.kdjN,
        k_period: q.kdjK,
        d_period: q.kdjD,
        use_zone: q.kdjUseZone,
      }
    case "band_swing":
      return { period: q.bandPeriod, std_mult: q.bandStd }
    case "swing_pivot":
      return {
        left: q.swingLeft,
        right: q.swingRight,
        min_right_live: q.swingMinRightLive,
        min_amplitude_pct: q.swingMinAmplitude,
        min_atr_mult: q.swingMinAtrMult,
        atr_period: q.swingAtrPeriod,
        signal_max_age: q.swingMaxAge,
        ...(q.swingResonanceTf
          ? { resonance_tf: q.swingResonanceTf }
          : {}),
        entry_mode: q.swingEntryMode,
        exit_mode: q.swingExitMode,
        stop_mode: q.swingStopMode,
        stop_buffer_points: q.swingStopBuffer,
        reverse_on_stop: q.swingReverseOnStop,
        reverse_stop_pct: q.swingReverseStopPct,
      }
    case "swing_pivot_v2":
      return {
        left: q.swingLeft,
        right: q.swingRight,
        proximity_atr_mult: q.swingProximity,
        wick_atr_mult: q.swingWickMult,
        attack_window: q.swingAttackWindow,
        vol_expand_ratio: q.swingVolExpand,
        vol_shrink_ratio: q.swingVolShrink,
        vol_ma_period: q.swingVolMaPeriod,
        cooldown: q.swingCooldown,
        atr_period: q.swingAtrPeriod,
      }
    case "strength_entry":
      return buildStrengthParams(q)
    case "strength_entry_v2":
      return buildStrengthV2Params(q)
    case "factor": {
      const et = Number(q.factorEntry)
      return {
        factor_tokens: parseFactorTokens(q.factorTokensText),
        ...(q.factorEntry.trim() !== "" && Number.isFinite(et) && et > 0
          ? { entry_threshold: et }
          : {}),
      }
    }
    default:
      return {}
  }
}

/** 前端校验；通过返回 null，失败返回错误文案 */
export function validateQuantParams(q: QuantParamsState): string | null {
  if (q.quantKind === "ma_cross" && q.fastPeriod >= q.slowPeriod) {
    return "快线须小于慢线"
  }
  if (q.quantKind === "n_breakout" && q.lookback < 2) {
    return "突破回看周期至少为 2"
  }
  if (q.quantKind === "macd_cross" && q.macdFast >= q.macdSlow) {
    return "MACD 快线须小于慢线"
  }
  if (q.quantKind === "band_swing" && q.bandPeriod < 5) {
    return "波段周期至少为 5"
  }
  const isSwing =
    q.quantKind === "swing_pivot" || q.quantKind === "swing_pivot_v2"
  if (isSwing && q.swingLeft < 1) {
    return "枢轴左侧分型根数至少为 1"
  }
  if (q.quantKind === "swing_pivot") {
    if (q.swingMaxAge < 1 || q.swingMaxAge > 20) {
      return "信号新鲜度窗口须在 1-20 根之间"
    }
    if (q.swingStopBuffer < 0 || q.swingStopBuffer > 5) {
      return "止损追加点数须在 0-5 之间"
    }
    if (q.swingReverseStopPct < 0 || q.swingReverseStopPct > 10) {
      return "反手止损百分比须在 0-10 之间"
    }
  }
  if (isSwing && q.swingRight < 2) {
    return "右侧确认根数至少为 2（对齐图表波段信号）"
  }
  if (
    q.quantKind === "swing_pivot" &&
    (q.swingMinRightLive < 1 || q.swingMinRightLive > q.swingRight)
  ) {
    return "盘中预确认根数须在 1 到右侧确认根数之间"
  }
  if (q.quantKind === "swing_pivot_v2" && q.swingVolShrink > q.swingVolExpand) {
    return "量能萎缩上限应不大于放大下限（中间带是无效区）"
  }
  const strengthErr = validateStrengthParams(q)
  if (strengthErr) return strengthErr
  if (q.quantKind === "factor" && parseFactorTokens(q.factorTokensText).length === 0) {
    return "因子公式 tokens 不能为空（从因子实验室复制）"
  }
  return null
}

/** K 线周期 → 分钟数（1d=1440；未知返回 0） */
export function timeframeMinutes(tf: string): number {
  const t = (tf || "").trim().toLowerCase()
  if (t === "1d") return 1440
  const m = /^(\d+)m$/.exec(t)
  return m ? Number(m[1]) : 0
}

/**
 * 量化任务分析间隔可选项（分钟）
 * 范围：1 分钟 ~ K 线周期（如 5m 因子最快 1 分钟、最慢 5 分钟）。
 * 60 分钟内逐分钟列出；之上（仅日线会超）补常用档位；末位恒为周期本身。
 */
export function quantIntervalMinuteOptions(tf: string): number[] {
  const tfMin = timeframeMinutes(tf)
  if (tfMin <= 0) return []
  const opts = new Set<number>()
  for (let m = 1; m <= Math.min(tfMin, 60); m++) opts.add(m)
  for (const m of [90, 120, 180, 240, 360, 480, 720, 1440]) {
    if (m <= tfMin) opts.add(m)
  }
  opts.add(tfMin)
  return [...opts].sort((a, b) => a - b)
}

/** 间隔分钟 → 展示文案（与决策模型「响应频率」同风格） */
export function quantIntervalLabel(min: number): string {
  if (min >= 1440) return "1440 分钟（每日K线收盘节奏）"
  return `${min} 分钟`
}
