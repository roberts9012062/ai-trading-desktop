/**
 * 形成中 K 线构造（forming-bar-spec/1）—— 本包最核心的共享代码。
 *
 * 重放器（回放冻结 digest）与流式预览（实时 WS）**共用本实现**，禁止第二套
 * （方案 B §5"同一实现两处使用"）。规格与服务器契约逐字段一致：
 *  - 量字段 = 原始累计量 ÷ 已过时间比例（量时间归一）
 *  - 无交易 bar：价格前向填充，量为 0
 */

import type { TickBucket } from "./digest"

/** 求值用 bar 形态（closed bars 与 forming bar 同构；引擎列名对齐） */
export interface ShortlineBar {
  /** bar 起点毫秒（UTC） */
  timeMs: number
  open: number
  high: number
  low: number
  close: number
  volume: number
  quoteVolume: number
  takerBuyVolume: number
  takerBuyQuoteVolume: number
  tradeCount: number
  /** v4 订单流特征列（orderflow.ts 同一实现产出；全量 bar=elapsed 100%） */
  sl: readonly number[]
  /** 是否形成中 bar（false = 已收盘） */
  forming: boolean
}

export interface FormingBarOptions {
  /** K 线周期（秒） */
  barSpanSeconds: number
  /** 归一开关：closed bar 用 1.0；重放按 cut 时刻已过比例 */
  normalizeVolume: boolean
}

/** 二分：最后一个 ts < edge 的桶下标（exclusive 上界） */
export function bucketUpperBound(buckets: readonly TickBucket[], edgeSec: number): number {
  let lo = 0, hi = buckets.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (buckets[mid]!.ts < edgeSec) lo = mid + 1
    else hi = mid
  }
  return lo
}

/**
 * 从桶序列构造一根 bar（含归一量与 v4 特征）。
 * 区间 [startMs, startMs + span*1000)；cutMs 为观察时刻（重放/实时），
 * closed bar 传 cutMs = endMs。
 * prevClose：区间内尚无成交时的价格填充（首个 bar 无前值传 NaN → open 用首笔）。
 */
export function buildFormingBar(
  buckets: readonly TickBucket[],
  fromIdx: number, // 含
  toIdxExclusive: number, // 不含（已按 cut 截断）
  startMs: number,
  cutMs: number,
  opts: FormingBarOptions,
  prevClose: number,
  computeOrderflow: (window: readonly TickBucket[], scale: number) => readonly number[],
): ShortlineBar {
  const span = opts.barSpanSeconds
  const endMs = startMs + span * 1000
  if (cutMs > endMs) throw new Error("cutMs 超出 bar 区间")
  let open = NaN, high = -Infinity, low = Infinity, close = NaN
  let vol = 0, quote = 0, takerBuyVol = 0, takerBuyQuote = 0, count = 0
  for (let i = fromIdx; i < toIdxExclusive; i++) {
    const b = buckets[i]!
    if (Number.isNaN(open)) open = b.open
    if (b.high > high) high = b.high
    if (b.low < low) low = b.low
    close = b.close
    vol += b.vol
    quote += b.quote
    takerBuyVol += b.takerBuyVol
    takerBuyQuote += b.takerBuyQuote
    count += b.count
  }
  const hasTrade = !Number.isNaN(open)
  if (!hasTrade) {
    open = high = low = close = prevClose
  }
  if (!Number.isFinite(high)) high = close
  if (!Number.isFinite(low)) low = close
  // 量时间归一：elapsed 下限 1 秒；closed bar（cut=end）scale=1
  const elapsedSec = Math.min(Math.max(Math.floor((cutMs - startMs) / 1000), 1), span)
  const scale = opts.normalizeVolume ? span / elapsedSec : 1
  const bar: ShortlineBar = {
    timeMs: startMs,
    open, high, low, close,
    volume: vol * scale,
    quoteVolume: quote * scale,
    takerBuyVolume: takerBuyVol * scale,
    takerBuyQuoteVolume: takerBuyQuote * scale,
    tradeCount: count * scale,
    sl: computeOrderflow(buckets.slice(fromIdx, toIdxExclusive), scale),
    forming: cutMs < endMs,
  }
  return bar
}

/** bar 边界对齐（UTC 整周期） */
export function barStartMs(tMs: number, barSpanSeconds: number): number {
  const span = barSpanSeconds * 1000
  return Math.floor(tMs / span) * span
}
