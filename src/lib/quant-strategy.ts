/** 量化策略类型与参数构造（回测 / 实时任务共用） */

export type QuantKind =
  | "n_breakout"
  | "ma_cross"
  | "macd_cross"
  | "kdj_cross"
  | "band_swing"
  | "swing_pivot"
  | "swing_pivot_v2"
  | "swing_pro"
  | "strength_entry"
  | "strength_entry_v2"
  | "factor"
  | "shortline_factor"

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
  // 短线因子（shortline_factor）：§4 决策参数 + cadence/预热/日亏
  slCadenceSec: number
  slWarmupBars: number
  slThreshold: number
  slConfirmSteps: number
  slMaxPerHour: number
  slDailyLoss: number
  // 专业波段（swing_pro）：双周期共振 / 单频 + 信号K线极值止损
  /** 第二周期（标准K线周期档 "1m"~"1d"；空=无第二周期；可大于或小于主周期） */
  proHtfTf: string
  /** 下单模式：single=单频 / resonance=多频共振（短等长） */
  proConfirmMode: "single" | "resonance"
  /** 反向信号平仓模式 */
  proExitMode: "single" | "resonance"
  /** 止损锚模式（single=主周期信号K线 / resonance=长周期信号K线） */
  proStopMode: "single" | "resonance"
  /** 止损追加点数 %（0-5，锚定信号K线极值外扩） */
  proStopExtraPct: number
  /** 信号新鲜窗口（根）：信号须出现在最近 N 根 K 线内才可下单/平仓 */
  proSignalWindow: number
  /** 止损后自动反手：信号仓被止损 → 立即开反向仓（反手仓不再反手） */
  proStopReverse: boolean
  /** 反手仓止损百分比（0.1-20；反手仓不用信号锚，用更紧的百分比止损） */
  proReverseStopPct: number
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
  slCadenceSec: 5,
  slWarmupBars: 300,
  slThreshold: 0.25,
  slConfirmSteps: 3,
  slMaxPerHour: 6,
  slDailyLoss: 50,
  proHtfTf: "",
  proConfirmMode: "single",
  proExitMode: "single",
  proStopMode: "single",
  proStopExtraPct: 1,
  proSignalWindow: 3,
  proStopReverse: false,
  proReverseStopPct: 2,
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
  { value: "swing_pro", label: "专业波段（双周期共振）" },
  { value: "strength_entry", label: "强弱进场" },
  { value: "strength_entry_v2", label: "强弱形态 V2（双向）" },
  { value: "factor", label: "因子公式" },
  { value: "shortline_factor", label: "短线因子" },
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
    case "shortline_factor": {
      const d = (p.decision ?? {}) as Record<string, unknown>
      const nd = (key: string, fb: number): number =>
        typeof d[key] === "number" && Number.isFinite(d[key] as number)
          ? (d[key] as number)
          : fb
      return {
        ...base,
        factorTokensText: Array.isArray(p.factor_tokens)
          ? (p.factor_tokens as number[]).join(",")
          : base.factorTokensText,
        slCadenceSec: n("cadence_seconds", 5),
        slWarmupBars: n("warmup_bars", 300),
        slThreshold: nd("threshold", 0.25),
        slConfirmSteps: nd("confirm_steps", 3),
        slMaxPerHour: nd("max_actions_per_hour", 6),
        slDailyLoss: n("daily_loss_limit_usdt", 50),
      }
    }
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
    case "swing_pro": {
      const mode = (key: string): "single" | "resonance" =>
        p[key] === "resonance" ? "resonance" : "single"
      return {
        ...base,
        swingLeft: n("left", 3),
        swingRight: n("right", 3),
        swingMinRightLive: n("min_right_live", 1),
        swingMinAmplitude: n("min_amplitude_pct", 1.5),
        swingMinAtrMult: n("min_atr_mult", 1.5),
        swingAtrPeriod: n("atr_period", 14),
        proHtfTf: typeof p["htf_tf"] === "string" ? p["htf_tf"] : "",
        proConfirmMode: mode("confirm_mode"),
        proExitMode: mode("exit_mode"),
        proStopMode: mode("stop_mode"),
        proStopExtraPct: n("stop_extra_pct", 1),
        proSignalWindow: Math.max(1, Math.min(10, Math.round(n("signal_window", 3)))),
        proStopReverse: p["stop_reverse"] === true,
        proReverseStopPct: n("reverse_stop_pct", 2),
      }
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
    case "swing_pro":
      return {
        left: q.swingLeft,
        right: q.swingRight,
        min_right_live: q.swingMinRightLive,
        min_amplitude_pct: q.swingMinAmplitude,
        min_atr_mult: q.swingMinAtrMult,
        atr_period: q.swingAtrPeriod,
        htf_tf: q.proHtfTf || null,
        confirm_mode: q.proConfirmMode,
        exit_mode: q.proExitMode,
        stop_mode: q.proStopMode,
        stop_extra_pct: q.proStopExtraPct,
        signal_window: q.proSignalWindow,
        stop_reverse: q.proStopReverse,
        reverse_stop_pct: q.proReverseStopPct,
      }
    case "strength_entry":
      return buildStrengthParams(q)
    case "strength_entry_v2":
      return buildStrengthV2Params(q)
    case "factor":
      return { factor_tokens: parseFactorTokens(q.factorTokensText) }
    case "shortline_factor":
      return {
        factor_tokens: parseFactorTokens(q.factorTokensText),
        cadence_seconds: q.slCadenceSec,
        warmup_bars: q.slWarmupBars,
        decision: {
          threshold: q.slThreshold,
          confirm_steps: q.slConfirmSteps,
          max_actions_per_hour: q.slMaxPerHour,
          max_actions_per_bar: 1,
          stale_multiplier: 2.0,
        },
        daily_loss_limit_usdt: q.slDailyLoss,
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
    q.quantKind === "swing_pivot" ||
    q.quantKind === "swing_pivot_v2" ||
    q.quantKind === "swing_pro"
  if (isSwing && q.swingLeft < 1) {
    return "枢轴左侧分型根数至少为 1"
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
  if (
    (q.quantKind === "factor" || q.quantKind === "shortline_factor") &&
    parseFactorTokens(q.factorTokensText).length === 0
  ) {
    return "因子公式 tokens 不能为空（从因子实验室收藏选择或复制）"
  }
  if (q.quantKind === "shortline_factor") {
    if (![3, 5, 10, 15, 30, 60].includes(q.slCadenceSec)) {
      return "打分节奏只支持 3/5/10/15/30/60 秒"
    }
    if (q.slWarmupBars < 60 || q.slWarmupBars > 2000) {
      return "预热 K 线根数须在 60~2000"
    }
    if (q.slThreshold <= 0 || q.slThreshold >= 1) {
      return "开仓阈值须在 (0,1)"
    }
    if (q.slConfirmSteps < 1 || q.slConfirmSteps > 50) {
      return "确认步数须在 1~50"
    }
    if (q.slMaxPerHour < 1 || q.slMaxPerHour > 60) {
      return "每小时动作上限须在 1~60"
    }
    if (q.slDailyLoss <= 0) {
      return "日亏停机额度须大于 0"
    }
  }
  const VALID_TFS = ["1m", "5m", "15m", "30m", "60m", "1d"]
  if (q.quantKind === "swing_pro") {
    if (q.proHtfTf && !VALID_TFS.includes(q.proHtfTf)) {
      return "第二周期无效（须为标准K线周期档）"
    }
    if (
      (q.proConfirmMode === "resonance" || q.proExitMode === "resonance" || q.proStopMode === "resonance") &&
      !q.proHtfTf
    ) {
      return "共振模式需选择第二周期"
    }
    if (q.proStopExtraPct < 0 || q.proStopExtraPct > 5) {
      return "止损追加点数须在 0~5% 之间"
    }
    if (q.proSignalWindow < 1 || q.proSignalWindow > 10) {
      return "信号新鲜窗口须在 1~10 根之间"
    }
    if (q.proStopReverse && (q.proReverseStopPct < 0.1 || q.proReverseStopPct > 20)) {
      return "反手止损百分比须在 0.1~20% 之间"
    }
  }
  return null
}
