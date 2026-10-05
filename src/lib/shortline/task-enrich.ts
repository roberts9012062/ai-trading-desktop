/**
 * 挖掘任务快照的 v4 列注入 —— digest → 每 bar sl_of0..7。
 *
 * 同一实现约束：per-bar 列值 = computeOrderflowRaw(bar 全窗口桶, scale=1)
 * 与重放/流式的形成中 bar 同一函数（full bar = elapsed 100%）。
 * 注入发生在 local-runner 冻结快照之后（bars 引用更新）。
 */

import { digestSha256, type TickBucket } from "./digest"
import { barStartMs, buildFormingBar } from "./forming-bar"
import { computeOrderflowRaw } from "./orderflow"
import { TIMEFRAME_SECONDS, type ShortlineTimeframe } from "./spec"
import { listDayDigests, listDayDigestMetadata, loadDayDigest } from "./backfill/pipeline"
import { barTimeToMs } from "@/lib/binance-kline"
import {okxArchiveDate, type ShortlineHistorySource} from "@/lib/okx-history"
import { sha256Hex } from "./digest"

export interface ShortlineBarRow {
  time: string | number
  open: number
  high: number
  low: number
  close: number
  volume: number
  quoteVolume?: number
  takerBuyVolume?: number
  tradeCount?: number
  [k: string]: unknown
}

interface BarLike {
  time: string | number
}

/** digest 桶序列 → 每根 bar 的 v4 原始值（对齐 bar 时间数组） */
export function orderflowColumnsForBars(
  buckets: readonly TickBucket[],
  barTimesMs: readonly number[],
  timeframe: ShortlineTimeframe,
  prevCloseSeed = NaN,
): number[][] {
  const spanSec = TIMEFRAME_SECONDS[timeframe]
  const span = spanSec * 1000
  const out: number[][] = []
  let prevClose = prevCloseSeed
  for (const t of barTimesMs) {
    const start = barStartMs(t, spanSec)
    const endSec = Math.floor((start + span) / 1000)
    const from = lowerBound(buckets, Math.floor(start / 1000))
    let to = from
    while (to < buckets.length && buckets[to]!.ts < endSec) to++
    const bar = buildFormingBar(buckets, from, to, start, start + span,
      { barSpanSeconds: spanSec, normalizeVolume: true }, prevClose, computeOrderflowRaw)
    if (!Number.isNaN(bar.close)) prevClose = bar.close
    out.push([...bar.sl])
  }
  return out
}

function lowerBound(buckets: readonly TickBucket[], sec: number): number {
  let lo = 0, hi = buckets.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (buckets[mid]!.ts < sec) lo = mid + 1
    else hi = mid
  }
  return lo
}

export interface EnrichResult {
  enrichedBars: number
  missingDays: string[]
  digestSha: string | null
}

/**
 * 给冻结快照 bars 注入 sl_of 列（原地修改并返回新数组）。
 * digest 覆盖不到的 bar → 不设列（引擎按缺失处理,masked NaN）。
 */
export async function enrichBarsWithOrderflow<T extends BarLike>(
  bars: readonly T[],
  symbol: string,
  timeframe: ShortlineTimeframe,
  source: ShortlineHistorySource = "binance_usdt",
): Promise<EnrichResult> {
  if (!bars.length) return { enrichedBars: 0, missingDays: [], digestSha: null }
  if (source === "okx") {
    // OKX times are Beijing strings; use epoch ms, not browser-local Date.parse.
    // Stream one daily digest at a time instead of retaining months of second buckets.
    const metadata = await listDayDigestMetadata(symbol.toUpperCase(),source)
    const byDay = new Map(metadata.map((e) => [e.day,e]))
    const groups = new Map<string,Array<{index:number;t:number}>>()
    bars.forEach((b,index) => {
      const t = typeof b.time === "number" ? b.time : barTimeToMs(b.time)
      const day = okxArchiveDate(t)
      if (!groups.has(day)) groups.set(day,[])
      groups.get(day)!.push({index,t})
    })
    const hashes: string[] = ["okx-orderflow-v1"], missingDays: string[] = []
    let enriched = 0, prevClose = NaN
    for (const [day,points] of groups) {
      const buckets = await loadDayDigest(symbol.toUpperCase(),day,source)
      if (!buckets?.length || !byDay.has(day)) { missingDays.push(day); continue }
      hashes.push(`${day}:${byDay.get(day)!.sha256}`)
      const cols = orderflowColumnsForBars(buckets,points.map((p) => p.t),timeframe,prevClose)
      points.forEach((point,i) => {
        const start = point.t / 1000, from = lowerBound(buckets,start)
        if (from >= buckets.length || buckets[from]!.ts >= start+TIMEFRAME_SECONDS[timeframe]) return
        const row = bars[point.index] as unknown as Record<string,unknown>
        cols[i]!.forEach((v,k) => {row[`sl_of${k}`]=v}); enriched++
      })
      prevClose = buckets.at(-1)!.close
    }
    if (missingDays.length) throw new Error(`OKX 订单流归档缺失：${missingDays.slice(0,5).join("、")}，请补齐后挖掘`)
    return {enrichedBars:enriched,missingDays,digestSha:sha256Hex(new TextEncoder().encode(hashes.join("\n")))}
  }
  const dayOf = (t: string | number) => new Date(typeof t === "number" ? t : Date.parse(String(t))).toISOString().slice(0, 10)
  const firstDay = dayOf(bars[0]!.time)
  const lastDay = dayOf(bars[bars.length - 1]!.time)
  const entries = (await listDayDigests(symbol.toUpperCase())).filter(
    (e) => e.day >= firstDay && e.day <= lastDay,
  )
  const have = new Set(entries.map((e) => e.day))
  const days: string[] = []
  for (const e of entries) days.push(e.day)
  // 首日之前一根 bar 的桶可能来自前一日 → 多载一天
  const prevDay = new Date(Date.parse(`${firstDay}T00:00:00Z`) - 86400000).toISOString().slice(0, 10)
  if (have.has(prevDay)) days.unshift(prevDay)
  if (!days.length) {
    return { enrichedBars: 0, missingDays: [firstDay, lastDay], digestSha: null }
  }
  const buckets: TickBucket[] = []
  for (const day of days) {
    const part = await loadDayDigest(symbol.toUpperCase(), day)
    if (part) buckets.push(...part)
  }
  if (!buckets.length) return { enrichedBars: 0, missingDays: days, digestSha: null }

  const times = bars.map((b) => (typeof b.time === "number" ? b.time : Date.parse(String(b.time))))
  const cols = orderflowColumnsForBars(buckets, times, timeframe)
  let enriched = 0
  const bucketTs = buckets.map((b) => b.ts * 1000)
  for (let i = 0; i < bars.length; i++) {
    const start = barStartMs(times[i]!, TIMEFRAME_SECONDS[timeframe])
    const end = start + TIMEFRAME_SECONDS[timeframe] * 1000
    // bar 覆盖检查（二分）：区间内存在任一桶即视为覆盖（空 bar 前向填充）
    const idx = lowerBoundMs(bucketTs, start)
    if (idx >= bucketTs.length || bucketTs[idx]! >= end) continue
    const row = bars[i] as unknown as Record<string, unknown>
    cols[i]!.forEach((v, k) => { row[`sl_of${k}`] = v })
    enriched++
  }
  return { enrichedBars: enriched, missingDays: [], digestSha: digestSha256(buckets) }
}

function lowerBoundMs(arr: readonly number[], v: number): number {
  let lo = 0, hi = arr.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (arr[mid]! < v) lo = mid + 1
    else hi = mid
  }
  return lo
}
