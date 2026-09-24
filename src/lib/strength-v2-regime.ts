/**
 * 强弱指标 V2 状态机与六档判定
 * （discuss/2026-08-31-强弱指标V2形态档设计.md 4.3-4.5，自 strength-v2.ts
 * 拆出以守住 300 行上限）
 *
 * - advanceRegime：① 滞回 regime 更新 + ② 段内极值/回调跟踪
 *   （新高判定用 >= / <=：翻转根 S==segPeakS 必须走重置分支，否则翻转根
 *   自己的 low 会被误记成回调低点，导致下一根误触发中继 —— 4.3 ② 陷阱）
 * - judgeTiers：③ 六档优先级判定（转向 / 动能衰竭 / 位置窗口 / 价格确认
 *   + 每档独立冷却；条件成立但被冷却挡住时继续判定低优先级档）
 *
 * 状态由调用方持有（initRegimeState 新建、单条序列遍历内独占），
 * 两个函数就地更新 state 并返回本根结果，不读写其他全局状态。
 */

import type { KlineBar } from "@/types"
import type {
  StrengthRegime,
  StrengthV2Kind,
  StrengthV2Params,
  StrengthV2Signal,
} from "./strength-v2.ts"
import { round2 } from "./strength-v2.ts"

/** 状态机状态（4.3「状态」清单；lastFired 为各档上次触发的 bar 下标） */
export interface RegimeState {
  regime: StrengthRegime
  /** 多头段内 S 的最高（regime=up 时有效） */
  segPeakS: number
  /** 空头段内 S 的最低（regime=down 时有效） */
  segTroughS: number
  /** 自 segPeak 之后的价格最低 low（+Inf = 尚无回调） */
  pullbackLowPrice: number
  /** 自 segTrough 之后的价格最高 high（−Inf = 尚无反弹） */
  reboundHighPrice: number
  /** 各档上次触发的 bar 下标（−Inf = 未触发过） */
  lastFired: Record<StrengthV2Kind, number>
}

/** 初始状态：regime=none，段内极值与回调/反弹极值均为未发生 */
export function initRegimeState(): RegimeState {
  return {
    regime: "none",
    segPeakS: 0,
    segTroughS: 0,
    pullbackLowPrice: Infinity,
    reboundHighPrice: -Infinity,
    lastFired: {
      bottom_exhaust: -Infinity,
      top_exhaust: -Infinity,
      rebound: -Infinity,
      breakdown: -Infinity,
      continuation_long: -Infinity,
      continuation_short: -Infinity,
    },
  }
}

/**
 * ① regime 更新（滞回）+ ② 段内极值与回调跟踪。
 * 返回本根是否为 down→up / up→down 的翻转；序列开头 none→x 是初始化，
 * 返回 false（不出转折信号 —— 4.3 ① 陷阱）。
 */
export function advanceRegime(
  state: RegimeState,
  s: number,
  bar: KlineBar,
  params: StrengthV2Params,
): boolean {
  let regimeFlipped = false
  // ① 只有 down→up / up→down 才算「翻转」；翻转时新段开始，回调未发生
  if (s > 50 + params.continuationBand) {
    if (state.regime !== "up") {
      const wasDown = state.regime === "down"
      state.regime = "up"
      state.segPeakS = s
      state.pullbackLowPrice = Infinity
      regimeFlipped = wasDown
    }
  } else if (s < 50 - params.continuationBand) {
    if (state.regime !== "down") {
      const wasUp = state.regime === "up"
      state.regime = "down"
      state.segTroughS = s
      state.reboundHighPrice = -Infinity
      regimeFlipped = wasUp
    }
  }

  // ② 段内极值与回调跟踪（>= / <=：翻转根 S==segPeakS 必须走重置分支）
  if (state.regime === "up") {
    if (s >= state.segPeakS) {
      state.segPeakS = s
      state.pullbackLowPrice = Infinity
    } else {
      state.pullbackLowPrice = Math.min(state.pullbackLowPrice, bar.low)
    }
  } else if (state.regime === "down") {
    if (s <= state.segTroughS) {
      state.segTroughS = s
      state.reboundHighPrice = -Infinity
    } else {
      state.reboundHighPrice = Math.max(state.reboundHighPrice, bar.high)
    }
  }
  return regimeFlipped
}

/** judgeTiers 的判定输入（调用方在 k≥2 时组装；下标约定见 4.3.1） */
export interface TierInput {
  /** 本根 S2 close（= 显示序列） */
  s: number
  /** d = S[i] − S[i−1] */
  d: number
  /** dPrev = S[i−1] − S[i−2] */
  dPrev: number
  /** 本根 bar（low/high 用于价格确认） */
  bar: KlineBar
  /** 二次平滑 close 序列（判定=显示；按 k 下标取值） */
  pClose: number[]
  /** 本根 ATR（bar 下标；预热段为 null → 中继两档不触发，不降级放行） */
  atr: number | null
  /** 本根 ①② 之前的回调/反弹极值（价格确认不含本根自身影线，4.6） */
  pullbackLowBefore: number
  reboundHighBefore: number
  /** S 序列下标 k 与 bar 下标 i（预热门槛用，4.7） */
  k: number
  i: number
  /** 本根 ①② 后 regime 是否翻转 */
  regimeFlipped: boolean
  params: StrengthV2Params
  isLastBar: boolean
}

/**
 * ③ 六档优先级判定（4.5）：命中且冷却放行即返回唯一信号（并更新该档
 * lastFired）；条件成立但被冷却挡住时继续判定低优先级档（V1 continue
 * 位置语义）。无信号返回 null。
 */
export function judgeTiers(
  state: RegimeState,
  input: TierInput,
): StrengthV2Signal | null {
  const { s, d, dPrev, bar, atr, params } = input
  const turnUp = dPrev <= 0 && d > 0
  const turnDown = dPrev >= 0 && d < 0

  // 价格确认：ATR 不可用（预热）时中继两档不触发，不是降级放行（4.5）
  let priceOkLong = false
  let priceOkShort = false
  if (atr !== null && atr > 0) {
    priceOkLong = bar.low >= input.pullbackLowBefore - params.priceBufferAtrMult * atr
    priceOkShort = bar.high <= input.reboundHighBefore + params.priceBufferAtrMult * atr
  }

  // 动能衰竭（4.4，方案一修订）：窗口不含信号根 [k−m, k−1] / [k−2m, k−m−1]——
  // 平顶/平底结束的首根阴阳柱常是大实体，含进窗会当场摧毁 flat/shrink；
  // 预热 i≥atrPeriod 且 k≥2m+1（窗口整体前移一根，防 ΔS 越界）
  let exhausted = false
  if (input.k >= 2 * params.exhaustWindow + 1 && input.i >= params.atrPeriod) {
    const m = params.exhaustWindow
    let nowSum = 0
    let prevSum = 0
    for (let j = input.k - m; j <= input.k - 1; j++) {
      nowSum += Math.abs(input.pClose[j] - input.pClose[j - 1])
    }
    for (let j = input.k - 2 * m; j <= input.k - m - 1; j++) {
      prevSum += Math.abs(input.pClose[j] - input.pClose[j - 1])
    }
    const bodyNow = nowSum / m
    const bodyPrev = prevSum / m
    const shrinking = bodyPrev > 0 && bodyNow / bodyPrev <= params.shrinkRatio
    let flat = true
    for (let j = input.k - m; j <= input.k - 1; j++) {
      if (Math.abs(input.pClose[j] - input.pClose[j - 1]) > params.flatEps) {
        flat = false
        break
      }
    }
    exhausted = shrinking || flat
  }

  // 段内相对位置（4.5，方案一修订）：距段峰/段谷 ≤ zoneDrop 即「顶部/底部附近」；
  // 段峰/谷由 ② 维护（已含本根）。深跌后反弹段价格新高 S 仅 ~60，绝对 75 线不可达
  const nearSegPeak = state.regime === "up" && state.segPeakS - s <= params.zoneDrop
  const nearSegTrough = state.regime === "down" && s - state.segTroughS <= params.zoneDrop

  const tiers: Array<{ kind: StrengthV2Kind; hit: boolean }> = [
    { kind: "rebound", hit: input.regimeFlipped && state.regime === "up" },
    { kind: "breakdown", hit: input.regimeFlipped && state.regime === "down" },
    {
      kind: "continuation_long",
      hit:
        state.regime === "up" &&
        !input.regimeFlipped &&
        turnUp &&
        Number.isFinite(state.pullbackLowPrice) &&
        priceOkLong,
    },
    {
      kind: "continuation_short",
      hit:
        state.regime === "down" &&
        !input.regimeFlipped &&
        turnDown &&
        Number.isFinite(state.reboundHighPrice) &&
        priceOkShort,
    },
    {
      kind: "bottom_exhaust",
      hit: state.regime === "down" && nearSegTrough && exhausted && d > 0,
    },
    {
      kind: "top_exhaust",
      hit: state.regime === "up" && nearSegPeak && exhausted && d < 0,
    },
  ]
  for (const tier of tiers) {
    if (tier.hit && input.i - state.lastFired[tier.kind] >= params.cooldown) {
      state.lastFired[tier.kind] = input.i
      return {
        time: bar.time,
        index: input.i,
        kind: tier.kind,
        value: round2(s),
        pending: input.isLastBar,
      }
    }
  }
  return null
}
