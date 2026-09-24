/**
 * 强弱指标前端计算内核（0–100 归一化副图蜡烛 + 三档进场信号）
 *
 * 与后端 services/signal_strength.py 逐位同源 —— 两端必须按相同顺序做
 * 相同的浮点运算，数值口径见 discuss/2026-08-31-强弱指标设计.md 第三节：
 * - 全程不做任何 round（float64 直通），仅在产出点/信号值时 half-up 保留 2 位
 * - 趋势均线不复用 lib/indicators.ts 的 calcSMA（其内部带 .toFixed(2) 舍入），
 *   本模块两端各自按「窗口左序求和后除以周期」实现，保证位级一致
 * - 因果性：强弱值与信号只用 [0, i] 数据，无未来函数；序列末根视为形成中，
 *   其信号 pending=true（未收盘确认，可能消失）；已收盘 bar 的信号永不撤销
 */

import type { KlineBar } from "@/types"

/** 强弱指标计算参数（StrengthConfig 的数值子集，不含开关与颜色） */
export interface StrengthParams {
  /** 归一化窗口（2-200），默认 14 */
  period: number
  /** 一次平滑周期（1-50），默认 3；1 = 不平滑 */
  smooth: number
  /** 二次平滑周期（1-50），默认 1 = 关闭（β=1 完全退化，无需特判） */
  smooth2: number
  /** 趋势均线周期（2-200），默认 10 */
  trendMaPeriod: number
  /** 波段进场阈值（0-100），默认 50 */
  swingThreshold: number
  /** 反弹进场阈值（0-100），默认 50 */
  reboundThreshold: number
  /** 弱区判定线（0-50），默认 20 */
  oversoldLevel: number
  /** 反弹回溯窗口（1-100 根），默认 10 */
  reboundLookback: number
  /** 极低位判定线（0-30），默认 5 */
  deepLevel: number
  /** 极低位钝化最少根数（1-50），默认 3 */
  deepBars: number
  /** 同档信号最小间隔根数（0-200），默认 3 */
  cooldown: number
}

/** 默认参数（标定基准；StrengthConfig 默认值的数值部分同源此处） */
export const DEFAULT_STRENGTH_PARAMS: StrengthParams = {
  period: 14,
  smooth: 3,
  smooth2: 1,
  trendMaPeriod: 10,
  swingThreshold: 50,
  reboundThreshold: 50,
  oversoldLevel: 20,
  reboundLookback: 10,
  deepLevel: 5,
  deepBars: 3,
  cooldown: 3,
}

/** 强弱指标数据点（副图蜡烛一根，二次平滑后，保留 2 位） */
export interface StrengthPoint {
  time: string
  open: number
  high: number
  low: number
  close: number
}

/** 进场信号三档 */
export type StrengthSignalKind = "swing" | "rebound" | "deep"

/** 进场信号 */
export interface StrengthSignal {
  time: string
  /** 触发 bar 在输入序列中的下标 */
  index: number
  kind: StrengthSignalKind
  /** 触发时的强弱值（主序列 S，保留 2 位） */
  value: number
  /** 末根（形成中）信号 —— 未收盘确认，可能消失 */
  pending: boolean
}

/** 计算输出：副图点序列 + 进场信号 */
export interface StrengthResult {
  points: StrengthPoint[]
  signals: StrengthSignal[]
}

/** half-up 保留 2 位（与后端 math.floor(x*100+0.5)/100 同口径；勿用 toFixed） */
function round2(x: number): number {
  return Math.round(x * 100) / 100
}

/**
 * 趋势均线：窗口内 close 自左向右求和后除以周期。
 * 每个窗口独立求和（非增量累减），两端按同序浮点运算保证逐位一致。
 */
function smaAt(closes: number[], i: number, period: number): number {
  let sum = 0
  for (let j = i - period + 1; j <= i; j++) {
    sum += closes[j]
  }
  return sum / period
}

/**
 * 计算强弱指标。
 * 输出点取二次平滑序列（smooth2=1 时与一次平滑位级相同）；
 * 三档信号一律判定一次平滑主序列 S（discuss 3.4）。
 */
export function calcStrength(
  bars: KlineBar[],
  params: StrengthParams,
): StrengthResult {
  const n = bars.length
  const first = params.period - 1
  if (n <= first) return { points: [], signals: [] }

  const alpha = 1 / params.smooth
  const beta = 1 / params.smooth2
  const count = n - first

  // 一次平滑主序列（下标 k 对应 bar 下标 first + k；k=0 首根直接取 raw）
  const sClose = new Array<number>(count)
  const sHigh = new Array<number>(count)
  const sLow = new Array<number>(count)
  // 二次平滑输出点（open 由前根 close 承接，不需单独存）
  const pClose = new Array<number>(count)
  const pHigh = new Array<number>(count)
  const pLow = new Array<number>(count)
  const points: StrengthPoint[] = []

  for (let k = 0; k < count; k++) {
    const i = first + k
    const bar = bars[i]
    // 归一化窗口 [i-period+1, i]：range==0（一字板/极端停滞）取 50
    let hh = -Infinity
    let ll = Infinity
    for (let j = i - params.period + 1; j <= i; j++) {
      if (bars[j].high > hh) hh = bars[j].high
      if (bars[j].low < ll) ll = bars[j].low
    }
    const range = hh - ll
    const rawClose = range === 0 ? 50 : ((bar.close - ll) / range) * 100
    const rawHigh = range === 0 ? 50 : ((bar.high - ll) / range) * 100
    const rawLow = range === 0 ? 50 : ((bar.low - ll) / range) * 100
    const rawOpen = range === 0 ? 50 : ((bar.open - ll) / range) * 100

    // 一次平滑：主序列递归；open/high/low 复用同一个上一状态 S[i-1]
    let sC: number
    let sH: number
    let sL: number
    if (k === 0) {
      sC = rawClose
      sH = rawHigh
      sL = rawLow
    } else {
      const prev = sClose[k - 1]
      sC = alpha * rawClose + (1 - alpha) * prev
      sH = alpha * rawHigh + (1 - alpha) * prev
      sL = alpha * rawLow + (1 - alpha) * prev
    }
    sClose[k] = sC
    sHigh[k] = sH
    sLow[k] = sL

    // 二次平滑：同结构再走一遍；首根直接承接一次平滑值
    let pC: number
    let pH: number
    let pL: number
    if (k === 0) {
      pC = sC
      pH = sH
      pL = sL
      points.push({
        time: bar.time,
        open: round2(rawOpen),
        high: round2(pH),
        low: round2(pL),
        close: round2(pC),
      })
    } else {
      const prevP = pClose[k - 1]
      pC = beta * sC + (1 - beta) * prevP
      pH = beta * sH + (1 - beta) * prevP
      pL = beta * sL + (1 - beta) * prevP
      // 蜡烛连续：open[i] = 二次平滑 close[i-1]
      points.push({
        time: bar.time,
        open: round2(prevP),
        high: round2(pH),
        low: round2(pL),
        close: round2(pC),
      })
    }
    pClose[k] = pC
    pHigh[k] = pH
    pLow[k] = pL
  }

  // 三档信号：判定一次平滑主序列；deep > rebound > swing，同根只出最强一档；
  // 高优先级档被冷却挡住时按伪代码落到低优先级档判定（discuss 3.4）
  const signals: StrengthSignal[] = []
  let lastDeep = -Infinity
  let lastRebound = -Infinity
  let lastSwing = -Infinity
  const closes = bars.map((b) => b.close)

  for (let k = 1; k < count; k++) {
    const i = first + k
    const sPrev = sClose[k - 1]
    const sCur = sClose[k]

    // deep：极低位钝化后首次拐头（S[i] 本身允许仍 ≤ deepLevel）
    let deepHit = false
    if (k >= params.deepBars && sCur > sPrev) {
      deepHit = true
      for (let d = 1; d <= params.deepBars; d++) {
        if (sClose[k - d] > params.deepLevel) {
          deepHit = false
          break
        }
      }
    }

    // rebound：近期到过弱区 + 回升上穿阈值
    let reboundHit = false
    if (k >= params.reboundLookback) {
      for (let j = k - params.reboundLookback; j <= k - 1; j++) {
        if (sClose[j] <= params.oversoldLevel) {
          reboundHit = true
          break
        }
      }
      reboundHit =
        reboundHit && sPrev < params.reboundThreshold && sCur >= params.reboundThreshold
    }

    // swing：上穿阈值 + 主图多头（close > SMA）
    let swingHit = false
    if (i >= params.trendMaPeriod - 1) {
      swingHit =
        sPrev < params.swingThreshold &&
        sCur >= params.swingThreshold &&
        closes[i] > smaAt(closes, i, params.trendMaPeriod)
    }

    const pending = i === n - 1
    if (deepHit && i - lastDeep >= params.cooldown) {
      signals.push({ time: bars[i].time, index: i, kind: "deep", value: round2(sCur), pending })
      lastDeep = i
      continue
    }
    if (reboundHit && i - lastRebound >= params.cooldown) {
      signals.push({ time: bars[i].time, index: i, kind: "rebound", value: round2(sCur), pending })
      lastRebound = i
      continue
    }
    if (swingHit && i - lastSwing >= params.cooldown) {
      signals.push({ time: bars[i].time, index: i, kind: "swing", value: round2(sCur), pending })
      lastSwing = i
    }
  }

  return { points, signals }
}
