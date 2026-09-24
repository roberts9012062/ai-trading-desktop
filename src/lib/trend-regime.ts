/**
 * 趋势状态（regime）判定：ADX/DMI + EMA 快慢
 *
 * 与后端 app/services/trend_regime.py 逐字对齐 —— 同一组 bars 必须得到
 * 同一组 regime。任何一侧改动都要同步另一侧，并跑 pivot-signals-v2.test.mjs。
 *
 * 用途：波段信号 V2 的方向门。单边行情里纯分型枢轴会把每个局部高点标成
 * 「空」，本模块判定「上升趋势 / 下降趋势 / 震荡」，让 V2 在趋势段只保留
 * 顺势方向的枢轴。
 *
 * 口径：ADX/DI 用 Wilder 平滑的「均值形式」（首值 = 前 period 个的算术
 * 平均，其后 (prev*(p-1)+cur)/p），与 pivot-signals.ts:calcATR 一致；
 * DI 是比值，均值形式与教科书求和形式完全等价。全部严格因果。
 */

import type { KlineBar } from "@/types"
import { calcEMA } from "./indicators.ts"

/** 趋势状态三态（互斥全覆盖） */
export const REGIME_TREND_UP = "trend_up"
export const REGIME_TREND_DOWN = "trend_down"
export const REGIME_RANGE = "range"

export type Regime = "trend_up" | "trend_down" | "range"

/** regime 判定参数 */
export interface RegimeOptions {
  adxPeriod: number
  adxThreshold: number
  emaFast: number
  emaSlow: number
}

/** 真实波幅序列；首根退化为 high-low（与 calcATR 同口径） */
function trueRange(klines: KlineBar[]): number[] {
  const n = klines.length
  const tr: number[] = new Array(n).fill(0)
  if (n === 0) return tr
  tr[0] = klines[0].high - klines[0].low
  for (let i = 1; i < n; i++) {
    const h = klines[i].high
    const l = klines[i].low
    const pc = klines[i - 1].close
    tr[i] = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc))
  }
  return tr
}

/**
 * +DM / -DM 序列（Wilder 定义，首根为 0）
 * +DM = 上涨幅度严格大于下跌幅度且为正时取上涨幅度，否则 0；-DM 对称。
 */
function directionalMovement(klines: KlineBar[]): {
  plusDM: number[]
  minusDM: number[]
} {
  const n = klines.length
  const plusDM: number[] = new Array(n).fill(0)
  const minusDM: number[] = new Array(n).fill(0)
  for (let i = 1; i < n; i++) {
    const upMove = klines[i].high - klines[i - 1].high
    const downMove = klines[i - 1].low - klines[i].low
    if (upMove > downMove && upMove > 0) plusDM[i] = upMove
    if (downMove > upMove && downMove > 0) minusDM[i] = downMove
  }
  return { plusDM, minusDM }
}

/**
 * Wilder 平滑（均值形式）：首值 = values[1..period] 的均值，其后递推
 * 从 index 1 起算（index 0 的 TR/DM 无前一根，不参与）。
 */
function wilderSmooth(
  values: number[],
  period: number,
  n: number,
): (number | null)[] {
  const out: (number | null)[] = new Array(n).fill(null)
  if (period <= 0 || n < period + 1) return out
  let acc = 0
  for (let i = 1; i <= period; i++) acc += values[i]
  acc /= period
  out[period] = acc
  for (let i = period + 1; i < n; i++) {
    acc = (acc * (period - 1) + values[i]) / period
    out[i] = acc
  }
  return out
}

/**
 * Wilder ADX 与 +DI / -DI
 *
 * 返回三个与 klines 等长的数组，前期不足为 null。
 * DI 自 index=period 起有值；ADX 需再累积 period 个 DX，自
 * index=2*period-1 起有值。
 */
export function calcADXDI(
  klines: KlineBar[],
  period: number,
): {
  adx: (number | null)[]
  diPlus: (number | null)[]
  diMinus: (number | null)[]
} {
  const n = klines.length
  const empty = (): (number | null)[] => new Array(n).fill(null)
  if (period <= 0 || n < period + 1) {
    return { adx: empty(), diPlus: empty(), diMinus: empty() }
  }

  const tr = trueRange(klines)
  const { plusDM, minusDM } = directionalMovement(klines)
  const trS = wilderSmooth(tr, period, n)
  const plusS = wilderSmooth(plusDM, period, n)
  const minusS = wilderSmooth(minusDM, period, n)

  const diPlus = empty()
  const diMinus = empty()
  const dx = empty()
  for (let i = period; i < n; i++) {
    const atr = trS[i]
    if (atr == null || atr <= 0) continue
    const pVal = plusS[i]
    const mVal = minusS[i]
    if (pVal == null || mVal == null) continue
    const dip = (100 * pVal) / atr
    const dim = (100 * mVal) / atr
    diPlus[i] = dip
    diMinus[i] = dim
    const total = dip + dim
    dx[i] = total > 0 ? (100 * Math.abs(dip - dim)) / total : 0
  }

  const adx = empty()
  const firstAdxIdx = 2 * period - 1
  if (n <= firstAdxIdx) return { adx, diPlus, diMinus }
  let sum = 0
  for (let i = period; i <= firstAdxIdx; i++) {
    const v = dx[i]
    if (v == null) return { adx, diPlus, diMinus }
    sum += v
  }
  let acc = sum / period
  adx[firstAdxIdx] = acc
  for (let i = firstAdxIdx + 1; i < n; i++) {
    const cur = dx[i]
    if (cur == null) continue
    acc = (acc * (period - 1) + cur) / period
    adx[i] = acc
  }
  return { adx, diPlus, diMinus }
}

/**
 * 逐 bar 的趋势状态
 *
 * trend_up   : ADX ≥ 阈值 且 +DI > -DI 且 EMA快 > EMA慢
 * trend_down : ADX ≥ 阈值 且 -DI > +DI 且 EMA快 < EMA慢
 * range      : 其余（含指标尚未就绪的前期）
 *
 * 三者取交集：ADX 只说明「在走趋势」不说明方向，DI 给方向但短期噪声大，
 * EMA 快慢给中期方向；三者一致才判趋势，避免在震荡转趋势的交界处误判后
 * 把顺势枢轴也一起丢掉。
 */
export function calcRegimes(
  klines: KlineBar[],
  options: RegimeOptions,
): Regime[] {
  const n = klines.length
  const out: Regime[] = new Array(n).fill(REGIME_RANGE)
  if (n === 0) return out

  const period = Math.max(1, Math.floor(options.adxPeriod))
  const { adx, diPlus, diMinus } = calcADXDI(klines, period)
  const closes = klines.map((bar) => bar.close)
  const fast = calcEMA(closes, Math.max(1, Math.floor(options.emaFast)))
  const slow = calcEMA(closes, Math.max(1, Math.floor(options.emaSlow)))

  for (let i = 0; i < n; i++) {
    const adxVal = adx[i]
    if (adxVal == null || adxVal < options.adxThreshold) continue
    const dip = diPlus[i]
    const dim = diMinus[i]
    if (dip == null || dim == null) continue
    const fastVal = fast[i]
    const slowVal = slow[i]
    if (fastVal == null || slowVal == null) continue
    if (dip > dim && fastVal > slowVal) {
      out[i] = REGIME_TREND_UP
    } else if (dim > dip && fastVal < slowVal) {
      out[i] = REGIME_TREND_DOWN
    }
  }
  return out
}
