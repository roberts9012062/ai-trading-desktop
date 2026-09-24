/**
 * 波段枢轴信号：Fractal 峰谷 + 盘整幅度过滤 + 盘中实时预确认
 */

import type { KlineBar } from "@/types"

/** 波段枢轴信号点 */
export interface PivotSignalPoint {
  time: string
  /** long=波谷做多；short=波峰做空 */
  side: "long" | "short"
  price: number
  /** 对应 K 线索引，便于查 ATR */
  index: number
  /**
   * 预确认：右侧确认根数尚未凑满，但已有右侧 K（含当前 forming）仍支持该峰/谷
   * 盘中实时用；收满 right 根后变为正式信号
   */
  provisional: boolean
}

/** 波段过滤参数 */
export interface PivotFilterOptions {
  /** 多空交替 */
  alternate: boolean
  /** 最小波段幅度%（相对上一信号价），0=不按%过滤 */
  minAmplitudePct: number
  /** 最小波段 ATR 倍数，0=不按 ATR 过滤 */
  minAtrMult: number
  /** ATR 周期 */
  atrPeriod: number
  /**
   * 盘中实时：右侧不足 right 根时，只要 ≥ minRightLive 根仍确认峰谷则出预确认信号
   * 默认 1（有 1 根回撤/反弹即可先标箭头，随行情可消失或转正）
   */
  minRightLive: number
}

/**
 * Wilder ATR（平均真实波幅）
 * 返回与 klines 等长数组，前期不足为 null
 */
export function calcATR(
  klines: KlineBar[],
  period: number,
): (number | null)[] {
  const n = klines.length
  const out: (number | null)[] = new Array(n).fill(null)
  if (period <= 0 || n < period + 1) return out

  const tr: number[] = new Array(n).fill(0)
  tr[0] = klines[0].high - klines[0].low
  for (let i = 1; i < n; i++) {
    const h = klines[i].high
    const l = klines[i].low
    const pc = klines[i - 1].close
    tr[i] = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc))
  }

  let sum = 0
  for (let i = 1; i <= period; i++) sum += tr[i]
  let atr = sum / period
  out[period] = atr
  for (let i = period + 1; i < n; i++) {
    atr = (atr * (period - 1) + tr[i]) / period
    out[i] = atr
  }
  return out
}

function isPivotAt(
  klines: KlineBar[],
  i: number,
  left: number,
  rightCount: number,
): { isHigh: boolean; isLow: boolean } {
  const hi = klines[i].high
  const lo = klines[i].low
  let isHigh = true
  let isLow = true
  for (let j = 1; j <= left; j++) {
    if (klines[i - j].high > hi) isHigh = false
    if (klines[i - j].low < lo) isLow = false
    if (!isHigh && !isLow) return { isHigh: false, isLow: false }
  }
  for (let j = 1; j <= rightCount; j++) {
    // 右侧严格比较：并列峰谷取最左
    if (klines[i + j].high >= hi) isHigh = false
    if (klines[i + j].low <= lo) isLow = false
    if (!isHigh && !isLow) break
  }
  return { isHigh, isLow }
}

/**
 * 计算枢轴高低点信号（Williams 分型 / Fractal）
 *
 * - 波谷做多 / 波峰做空
 * - 正式信号：左右各 left/right 根收完确认
 * - 盘中：右侧不足时按 minRightLive 出预确认（含 forming bar），行情破坏则消失
 * - 幅度过滤：反向不足 min% / ATR 视为盘整
 */
export function calcPivotSignals(
  klines: KlineBar[],
  left: number,
  right: number,
  filter: PivotFilterOptions,
): PivotSignalPoint[] {
  const n = klines.length
  if (left < 1 || right < 1 || n < left + 2) return []

  const minRightLive = Math.max(
    1,
    Math.min(right, Math.floor(filter.minRightLive || 1)),
  )
  const raw: PivotSignalPoint[] = []

  // 至少需要 1 根右侧（含当前未收盘 K），才能谈峰谷
  for (let i = left; i <= n - 1 - minRightLive; i++) {
    const availRight = n - 1 - i
    if (availRight < minRightLive) continue

    // 优先用满 right 根；不够则用已有根数做预确认
    const rightCount = Math.min(right, availRight)
    const { isHigh, isLow } = isPivotAt(klines, i, left, rightCount)
    if (isHigh && isLow) continue
    if (!isHigh && !isLow) continue

    const provisional = rightCount < right
    if (isHigh) {
      raw.push({
        time: klines[i].time,
        side: "short",
        price: klines[i].high,
        index: i,
        provisional,
      })
    } else {
      raw.push({
        time: klines[i].time,
        side: "long",
        price: klines[i].low,
        index: i,
        provisional,
      })
    }
  }

  if (raw.length === 0) return raw

  // 多空交替：同向只留更极端（预确认也可被更极端替换）
  let seq = raw
  if (filter.alternate) {
    const alt: PivotSignalPoint[] = [raw[0]]
    for (let i = 1; i < raw.length; i++) {
      const prev = alt[alt.length - 1]
      const cur = raw[i]
      if (cur.side === prev.side) {
        if (cur.side === "long" && cur.price < prev.price) {
          alt[alt.length - 1] = cur
        } else if (cur.side === "short" && cur.price > prev.price) {
          alt[alt.length - 1] = cur
        }
      } else {
        alt.push(cur)
      }
    }
    seq = alt
  }

  const minPct = Math.max(0, filter.minAmplitudePct)
  const minAtr = Math.max(0, filter.minAtrMult)
  if (minPct <= 0 && minAtr <= 0) return seq

  const atrPeriod = Math.max(1, Math.floor(filter.atrPeriod || 14))
  const atrArr = minAtr > 0 ? calcATR(klines, atrPeriod) : null

  const out: PivotSignalPoint[] = [seq[0]]
  for (let i = 1; i < seq.length; i++) {
    const prev = out[out.length - 1]
    const cur = seq[i]
    if (cur.side === prev.side) {
      if (cur.side === "long" && cur.price < prev.price) {
        out[out.length - 1] = cur
      } else if (cur.side === "short" && cur.price > prev.price) {
        out[out.length - 1] = cur
      }
      continue
    }
    const move = Math.abs(cur.price - prev.price)
    const thrPct =
      minPct > 0 && prev.price > 0 ? (Math.abs(prev.price) * minPct) / 100 : 0
    let thrAtr = 0
    if (atrArr && minAtr > 0) {
      const a = atrArr[cur.index] ?? atrArr[prev.index]
      if (a != null && a > 0) thrAtr = a * minAtr
    }
    const thr = Math.max(thrPct, thrAtr)
    if (thr <= 0 || move >= thr) {
      out.push(cur)
    }
  }
  return out
}
