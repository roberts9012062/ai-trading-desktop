import type { KlineBar } from "@/types"

/** 均线数据点 */
export interface MADataPoint {
  time: string
  value: number
}

/** MACD 数据点 */
export interface MACDDataPoint {
  time: string
  dif: number
  dea: number
  macd: number
}

/** 布林带数据点 */
export interface BOLLDataPoint {
  time: string
  upper: number
  middle: number
  lower: number
}

/**
 * 计算简单移动平均线（SMA）
 * 数据不足周期长度时跳过该点
 */
export function calcSMA(klines: KlineBar[], period: number): MADataPoint[] {
  const result: MADataPoint[] = []
  for (let i = period - 1; i < klines.length; i++) {
    let sum = 0
    for (let j = i - period + 1; j <= i; j++) {
      sum += klines[j].close
    }
    result.push({ time: klines[i].time, value: +(sum / period).toFixed(2) })
  }
  return result
}

/**
 * 计算指数移动平均线（EMA）
 * EMA(t) = price(t) * k + EMA(t-1) * (1 - k)，k = 2 / (period + 1)
 * 首个 EMA 用前 period 个数据的 SMA 作为种子
 */
export function calcEMA(closes: number[], period: number): (number | null)[] {
  const k = 2 / (period + 1)
  const result: (number | null)[] = new Array(closes.length).fill(null)

  if (closes.length < period) return result

  let sum = 0
  for (let i = 0; i < period; i++) sum += closes[i]
  result[period - 1] = sum / period

  for (let i = period; i < closes.length; i++) {
    const prev = result[i - 1]!
    result[i] = closes[i] * k + prev * (1 - k)
  }

  return result
}

/**
 * 计算 MACD 指标
 * DIF = EMA(close, fast) - EMA(close, slow)
 * DEA = EMA(DIF, signal)
 * MACD 柱 = 2 * (DIF - DEA)
 */
export function calcMACD(
  klines: KlineBar[],
  fastPeriod: number,
  slowPeriod: number,
  signalPeriod: number
): MACDDataPoint[] {
  const closes = klines.map((k) => k.close)
  const emaFast = calcEMA(closes, fastPeriod)
  const emaSlow = calcEMA(closes, slowPeriod)

  const difValues: (number | null)[] = closes.map((_, i) => {
    if (emaFast[i] === null || emaSlow[i] === null) return null
    return emaFast[i]! - emaSlow[i]!
  })

  const difCloses: number[] = difValues.map((v) => v ?? 0)
  const deaValues = calcEMA(difCloses, signalPeriod)

  const result: MACDDataPoint[] = []
  for (let i = 0; i < klines.length; i++) {
    if (difValues[i] === null || deaValues[i] === null) continue
    const dif = difValues[i]!
    const dea = deaValues[i]!
    const macd = 2 * (dif - dea)
    result.push({
      time: klines[i].time,
      dif: +dif.toFixed(4),
      dea: +dea.toFixed(4),
      macd: +macd.toFixed(4),
    })
  }
  return result
}

/**
 * 计算 RSI（Wilder 平滑）
 * 首段用 SMA(gain/loss)，之后 avg = (prev*(n-1)+cur)/n
 * RSI = 100 - 100/(1+RS)
 */
export function calcRSI(klines: KlineBar[], period: number): MADataPoint[] {
  if (period <= 0 || klines.length <= period) return []

  const closes = klines.map((k) => k.close)
  let gains = 0
  let losses = 0
  for (let i = 1; i <= period; i++) {
    const delta = closes[i] - closes[i - 1]
    if (delta >= 0) gains += delta
    else losses -= delta
  }
  let avgGain = gains / period
  let avgLoss = losses / period

  const result: MADataPoint[] = []
  const pushRsi = (index: number, ag: number, al: number) => {
    const rsi =
      al === 0 ? 100 : +(100 - 100 / (1 + ag / al)).toFixed(2)
    result.push({ time: klines[index].time, value: rsi })
  }
  pushRsi(period, avgGain, avgLoss)

  for (let i = period + 1; i < closes.length; i++) {
    const delta = closes[i] - closes[i - 1]
    const gain = delta > 0 ? delta : 0
    const loss = delta < 0 ? -delta : 0
    avgGain = (avgGain * (period - 1) + gain) / period
    avgLoss = (avgLoss * (period - 1) + loss) / period
    pushRsi(i, avgGain, avgLoss)
  }
  return result
}

/** JDK（KDJ）数据点 */
export interface JDKDataPoint {
  time: string
  k: number
  d: number
  j: number
}

/**
 * 计算 JDK（KDJ）—— 国内期货通用写法
 *
 * RSV = (C - Ln) / (Hn - Ln) * 100
 * K   = (kPeriod-1)/kPeriod * prevK + 1/kPeriod * RSV
 * D   = (dPeriod-1)/dPeriod * prevD + 1/dPeriod * K
 * J   = 3K - 2D
 *
 * 首值 K=D=RSV；分母为 0 时 RSV=50
 */
export function calcKDJ(
  klines: KlineBar[],
  rsvPeriod: number,
  kPeriod: number,
  dPeriod: number
): JDKDataPoint[] {
  if (rsvPeriod <= 0 || kPeriod <= 0 || dPeriod <= 0) return []
  if (klines.length < rsvPeriod) return []

  const kW = 1 / kPeriod
  const dW = 1 / dPeriod
  const result: JDKDataPoint[] = []
  let prevK = 50
  let prevD = 50

  for (let i = rsvPeriod - 1; i < klines.length; i++) {
    let hh = klines[i].high
    let ll = klines[i].low
    for (let j = i - rsvPeriod + 1; j <= i; j++) {
      if (klines[j].high > hh) hh = klines[j].high
      if (klines[j].low < ll) ll = klines[j].low
    }
    const range = hh - ll
    const rsv = range === 0 ? 50 : ((klines[i].close - ll) / range) * 100
    const k =
      i === rsvPeriod - 1
        ? rsv
        : (1 - kW) * prevK + kW * rsv
    const d =
      i === rsvPeriod - 1
        ? k
        : (1 - dW) * prevD + dW * k
    const j = 3 * k - 2 * d
    prevK = k
    prevD = d
    result.push({
      time: klines[i].time,
      k: +k.toFixed(2),
      d: +d.toFixed(2),
      j: +j.toFixed(2),
    })
  }
  return result
}

/**
 * 计算布林带
 * 中轨 = SMA(close, period)
 * 上下轨 = 中轨 ± std * 标准差（总体方差 / period）
 */
export function calcBOLL(
  klines: KlineBar[],
  period: number,
  stdMult: number
): BOLLDataPoint[] {
  if (period <= 0 || klines.length < period) return []
  const result: BOLLDataPoint[] = []
  for (let i = period - 1; i < klines.length; i++) {
    let sum = 0
    for (let j = i - period + 1; j <= i; j++) sum += klines[j].close
    const middle = sum / period
    let variance = 0
    for (let j = i - period + 1; j <= i; j++) {
      const d = klines[j].close - middle
      variance += d * d
    }
    const std = Math.sqrt(variance / period)
    result.push({
      time: klines[i].time,
      upper: +(middle + stdMult * std).toFixed(2),
      middle: +middle.toFixed(2),
      lower: +(middle - stdMult * std).toFixed(2),
    })
  }
  return result
}

// 波段信号算法拆至 pivot-signals.ts，保持本文件体量
// 显式 .ts 扩展名：让本模块可被 node --test 直接加载（Node 原生 TS 剥离
// 要求相对导入带扩展名），pivot-signals-v2.test.mjs 依赖这条链路。
export {
  calcATR,
  calcPivotSignals,
  type PivotFilterOptions,
  type PivotSignalPoint,
} from "./pivot-signals.ts"
