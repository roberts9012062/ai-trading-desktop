/**
 * v4 订单流特征原始值（8 个，token 115-122 对应）—— 同一实现三处共用：
 * 回填聚合（closed bar 列）、tick 重放（形成中 bar）、流式预览（实时）。
 *
 * 输入为 bar 区间内的 1 秒桶窗口（已按 cut 截断）与量时间归一系数 scale。
 * 比例类特征天然 scale 无关；绝对量类（SL_TRD_INT 的 count）显式用 scale。
 * 定义冻结见 docs/plans/2026-09-30-shortline-lab-implementation.md §1。
 */

import type { TickBucket } from "./digest"

/** 空窗口（bar 内尚无成交）的冻结默认值 */
export const EMPTY_ORDERFLOW: readonly number[] = [0, 0, 0, 0, 0, 1, 0, 0]

export function computeOrderflowRaw(window: readonly TickBucket[], scale: number): readonly number[] {
  const n = window.length
  if (n === 0) return EMPTY_ORDERFLOW
  let vol = 0, quote = 0, takerBuyVol = 0, count = 0, maxVol = -Infinity
  for (const b of window) {
    vol += b.vol
    quote += b.quote
    takerBuyVol += b.takerBuyVol
    count += b.count
    if (b.vol > maxVol) maxVol = b.vol
  }
  const meanVol = vol / n
  const close = window[n - 1]!.close

  // 0 SL_OF_IMB：主动买占比
  const ofImb = vol > 0 ? takerBuyVol / vol : 0

  // 1 SL_BIG_SHARE：vol ≥ 5×均秒 vol 的大额秒占比
  let bigVol = 0
  if (vol > 0) {
    const threshold = 5 * meanVol
    for (const b of window) if (b.vol >= threshold) bigVol += b.vol
  }

  // 2 SL_TRD_INT：ln(1+归一笔数)
  const trdInt = Math.log1p(count * scale)

  // 3 SL_PV_DIV：秒内方向翻转频率
  let flips = 0
  let prevDir = 0
  for (const b of window) {
    const d = b.close > b.open ? 1 : b.close < b.open ? -1 : 0
    if (d !== 0) {
      if (prevDir !== 0 && d !== prevDir) flips++
      prevDir = d
    }
  }
  const pvDiv = flips / Math.max(n - 1, 1)

  // 4 SL_VWAP_DEV：close/VWAP − 1
  const vwap = vol > 0 ? quote / vol : close
  const vwapDev = vol > 0 ? close / vwap - 1 : 0

  // 5 SL_BURST：max/均秒 vol（cap 1000；空桶量=0 时 mean=0 → 1）
  const burst = meanVol > 0 ? Math.min(maxVol / meanVol, 1000) : 1

  // 6 SL_STREAK_SIG：最长同主导方向秒连击 × 方向 / 桶数
  let bestRun = 0, bestSign = 0
  let run = 0, runSign = 0
  for (const b of window) {
    const half = b.vol / 2
    const side = b.takerBuyVol > half ? 1 : b.takerBuyVol < half ? -1 : 0
    if (side === 0 || side !== runSign) {
      runSign = side
      run = side === 0 ? 0 : 1
    } else {
      run++
    }
    if (run > bestRun || (run === bestRun && runSign !== 0)) {
      bestRun = run
      bestSign = runSign
    }
  }
  const streakSig = bestSign * (bestRun / n)

  // 7 SL_RHYTHM_ENT：秒 vol 分布归一 Shannon 熵
  let entropy = 0
  if (vol > 0 && n > 1) {
    for (const b of window) {
      const p = b.vol / vol
      if (p > 0) entropy -= p * Math.log(p)
    }
    entropy /= Math.log(n)
  }

  return [
    ofImb,
    vol > 0 ? bigVol / vol : 0,
    trdInt,
    pvDiv,
    vwapDev,
    burst,
    streakSig,
    entropy,
  ]
}
