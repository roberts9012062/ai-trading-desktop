/**
 * Tick 重放验证器（M-D1 核心）—— 冻结 digest + cadence → 重建形成中 K 线 →
 * 逐冠军+组合打分 → 分数流。
 *
 * 确定性契约（验收门 D1）：同 digest + 同 cadence + 同公式集合，双跑输出
 * 逐位一致（f64 位模式序列相等）。无时钟读取、无随机、无外部状态。
 * 形成中 K 线构造与流式预览共用 forming-bar.ts/orderflow.ts（禁止第二套）。
 */

import type { TickBucket } from "./digest"
import { scoreAtWindow, type ChampionFormula } from "./evaluator"
import { barStartMs, buildFormingBar, type ShortlineBar } from "./forming-bar"
import { computeOrderflowRaw } from "./orderflow"
import { comboScore, type CadenceSeconds, type ShortlineTimeframe, TIMEFRAME_SECONDS } from "./spec"

export interface ReplayOptions {
  timeframe: ShortlineTimeframe
  cadence: CadenceSeconds
  champions: readonly ChampionFormula[]
  /** 组合权重（Σ=1；缺省等权） */
  weights?: readonly number[]
  initialClosedBars?: readonly ShortlineBar[]
  minWarmupBars?: number
  onProgress?: (t: number) => void
}

export interface ReplayStep {
  price?: number
  priceTs?: number | null
  /** 采样时刻（毫秒，cadence 网格） */
  t: number
  /** 各冠军 score（tanh）；null=该冠军无效 */
  scores: Array<number | null>
  /** 组合分（Σ wᵢ·scoreᵢ）；任一冠军无效 → null */
  combo: number | null
  /** 该步 forming bar 所属周期起点（毫秒） */
  barStart: number
  /** cut 已过的秒数（量归一分母依据） */
  elapsedSec: number
}

export interface ReplayResult {
  steps: ReplayStep[]
  /** 数据集指纹 */
  digestSha: string
  options: ReplayOptions
}

/** 算子滚动窗宽（token 求值历史深度推导用；与 OPS_CONFIG 窗口对齐） */
export const OP_WINDOWS: Record<number, number> = {
  13: 5, 14: 10, 15: 20, 16: 10, 17: 20, 18: 10, 19: 20, 20: 10, 21: 10, 22: 20,
  23: 20, 24: 1, 25: 5, 27: 1, 28: 5, 29: 20, 30: 60, 31: 60, 32: 60, 33: 60,
  34: 20, 35: 20, 36: 20, 38: 5, 39: 20, 40: 20, 41: 60, 42: 10, 43: 20, 44: 20,
  45: 20, 46: 20, 47: 60, 48: 60, 49: 120, 50: 24,
}

/** 公式需要的 bar 历史深度（求值窗口长度；含特征/算子/输出归一化窗） */
export function requiredHistoryBars(
  tokens: readonly number[],
  timeframe: ShortlineTimeframe,
  normWindow: number,
): number {
  const spanSec = TIMEFRAME_SECONDS[timeframe]
  const barPerDay = Math.ceil(86400 / spanSec)
  const W = Math.max(normWindow, Math.max(200, barPerDay))
  let maxOp = 1
  let featureWarmup = 60
  for (const t of tokens) {
    if (t >= 64 && t < 115) {
      const w = OP_WINDOWS[t - 64]
      if (w && w > maxOp) maxOp = w
    } else if (t >= 115) featureWarmup = Math.max(featureWarmup, 300)
    else if (t >= 40) featureWarmup = Math.max(featureWarmup, 200)
  }
  return W + featureWarmup + maxOp + W + 10
}

/** 把 digest 聚合为 closed bars（每个 bar 带 v4 原始值；elapsed=100%） */
export function closedBarsFromDigest(
  buckets: readonly TickBucket[],
  timeframe: ShortlineTimeframe,
  fromBarStartMs: number,
  toBarEndExclusiveMs: number,
): ShortlineBar[] {
  const spanSec = TIMEFRAME_SECONDS[timeframe]
  const span = spanSec * 1000
  const bars: ShortlineBar[] = []
  let prevClose = NaN
  let cursor = bucketUpperBoundSafe(buckets, Math.floor(fromBarStartMs / 1000))
  for (let start = fromBarStartMs; start + span <= toBarEndExclusiveMs; start += span) {
    const endSec = Math.floor((start + span) / 1000)
    const from = cursor
    let to = cursor
    while (to < buckets.length && buckets[to]!.ts < endSec) to++
    cursor = to
    const bar = buildFormingBar(buckets, from, to, start, start + span,
      { barSpanSeconds: spanSec, normalizeVolume: true }, prevClose, computeOrderflowRaw)
    if (!Number.isNaN(bar.close)) prevClose = bar.close
    bars.push(bar)
  }
  return bars
}

function bucketUpperBoundSafe(buckets: readonly TickBucket[], edgeSec: number): number {
  let lo = 0, hi = buckets.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (buckets[mid]!.ts < edgeSec) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** cadence 网格步进重放（主入口） */
export function replayScores(
  buckets: readonly TickBucket[],
  opts: ReplayOptions,
  digestSha: string,
): ReplayResult {
  if (!buckets.length) return { steps: [], digestSha, options: opts }
  const spanSec = TIMEFRAME_SECONDS[opts.timeframe]
  const span = spanSec * 1000
  const firstTsMs = buckets[0]!.ts * 1000
  const lastTsMs = buckets[buckets.length - 1]!.ts * 1000
  // 首个 bar 起点（含首桶），末 bar（含末桶，作 closed 处理到其结束）
  const firstBarStart = barStartMs(firstTsMs, spanSec)
  const lastBarStart = barStartMs(lastTsMs, spanSec)
  const weights = opts.weights ?? Array.from({ length: opts.champions.length }, () => 1 / Math.max(1, opts.champions.length))

  // 预切每 bar 桶区间
  const barRanges: Array<{ start: number, from: number, to: number }> = []
  let cursor = 0
  for (let start = firstBarStart; start <= lastBarStart; start += span) {
    const endSec = Math.floor((start + span) / 1000)
    const from = cursor
    let to = cursor
    while (to < buckets.length && buckets[to]!.ts < endSec) to++
    cursor = to
    barRanges.push({ start, from, to })
  }

  // 预估 normWindow（用整段 bar 间距口径——1m→1440 等；与流式一致由
  // normWindowForBars 在窗口上计算，此处仅用于历史深度预算）
  const perDay = Math.ceil(86400 / spanSec)
  const estW = Math.max(200, perDay)
  let maxNeed = 0
  for (const ch of opts.champions) {
    maxNeed = Math.max(maxNeed, requiredHistoryBars(ch.tokens, opts.timeframe, estW))
  }

  const steps: ReplayStep[] = []
  const cadenceMs = opts.cadence * 1000
  // 网格从首个"完整 bar 之后"的 cadence 点开始（保证至少 1 根 closed bar）
  const firstGrid = Math.max(opts.initialClosedBars?.length ? firstBarStart : firstBarStart + span, Math.ceil((firstTsMs + cadenceMs) / cadenceMs) * cadenceMs)
  let prevClose = opts.initialClosedBars?.at(-1)?.close ?? NaN
  const closedBars: ShortlineBar[] = [...(opts.initialClosedBars ?? [])]
  let closedCursor = 0
  const rangeMap = new Map(barRanges.map((r) => [r.start, r]))

  for (let t = firstGrid; t <= lastTsMs; t += cadenceMs) {
    if ((t - firstGrid) % (cadenceMs * 200) === 0) opts.onProgress?.(t)
    const curBarStart = barStartMs(t, spanSec)
    // 收割已 closed 的 bar
    while (closedCursor < barRanges.length && barRanges[closedCursor]!.start < curBarStart) {
      const range = barRanges[closedCursor++]!
      if (closedBars.length && closedBars[closedBars.length - 1]!.timeMs >= range.start) continue
      const bar = buildFormingBar(buckets, range.from, range.to, range.start, range.start + span,
        { barSpanSeconds: spanSec, normalizeVolume: true }, prevClose, computeOrderflowRaw)
      if (!Number.isNaN(bar.close)) prevClose = bar.close
      closedBars.push(bar)
    }
    // forming bar at t
    const range = rangeMap.get(curBarStart)
    let priceTs: number | null = null
    let forming: ShortlineBar
    if (range) {
      // 严格因果：秒桶 s 在 cut t 可见 ⇔ s+1 ≤ t（桶 [s,s+1) 已完整过去）
      const cutSecExclusive = Math.floor(t / 1000)
      let to = range.from
      while (to < buckets.length && buckets[to]!.ts < cutSecExclusive) to++
      priceTs = to > 0 ? (buckets[to - 1]!.ts + 1) * 1000 : null
      forming = buildFormingBar(buckets, range.from, to, curBarStart, t,
        { barSpanSeconds: spanSec, normalizeVolume: true }, prevClose, computeOrderflowRaw)
    } else {
      // 该 bar 区间完全无桶（find 不到说明 curBarStart 不在 barRanges——
      // 只会发生在首 bar 之前，已由 firstGrid 排除）
      continue
    }
    const windowBars = closedBars.length > maxNeed ? closedBars.slice(closedBars.length - maxNeed) : closedBars
    if (opts.minWarmupBars && windowBars.length < opts.minWarmupBars) continue
    const { scores } = scoreAtWindow([...windowBars, forming], opts.champions)
    const anyNull = scores.some((s) => s === null)
    steps.push({
      t,
      price: forming.close,
      priceTs,
      scores,
      combo: anyNull ? null : comboScore(scores as number[], weights as number[]),
      barStart: curBarStart,
      elapsedSec: Math.min(Math.max(Math.floor((t - curBarStart) / 1000), 1), spanSec),
    })
  }

  return { steps, digestSha, options: opts }
}

/** f64 → 位模式十六进制（D1 逐位一致证据的序列化形态） */
export function f64Bits(v: number | null): string {
  if (v === null || Number.isNaN(v)) return v === null ? "null" : "nan"
  const buf = new ArrayBuffer(8)
  new DataView(buf).setFloat64(0, v, true)
  const bytes = new Uint8Array(buf)
  let hex = ""
  for (let i = 0; i < 8; i++) hex += bytes[i]!.toString(16).padStart(2, "0")
  return hex
}

/** 重放结果的逐位指纹（跨实现比对用） */
export function replayBits(result: ReplayResult): string {
  return result.steps.map((s) => `${s.t}:${s.scores.map(f64Bits).join(",")}|${f64Bits(s.combo)}`).join("\n")
}

