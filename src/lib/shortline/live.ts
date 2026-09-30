/**
 * 流式打分引擎（M-D3 预览用；纯 UI 预览，不下单）。
 *
 * 与重放器共用 forming-bar/orderflow/evaluator 同一实现（验收门 D3：同一
 * tick 序列上实时=回放）。cadence 触发由外部定时器传入 t（引擎本体不读
 * 时钟，保证可测与确定性）。closed bars 可用历史 K 线预热（warmup）。
 */

import type { AggTradeEvent, BucketAccumulator } from "./bucket-stream"
import { BucketAccumulator as Accumulator } from "./bucket-stream"
import type { TickBucket } from "./digest"
import { scoreAtWindow, type ChampionFormula } from "./evaluator"
import { barStartMs, buildFormingBar, type ShortlineBar } from "./forming-bar"
import { computeOrderflowRaw } from "./orderflow"
import { comboScore, type CadenceSeconds, type ShortlineTimeframe, TIMEFRAME_SECONDS } from "./spec"
import { requiredHistoryBars } from "./replay"

export interface LiveEngineOptions {
  timeframe: ShortlineTimeframe
  cadence: CadenceSeconds
  champions: readonly ChampionFormula[]
  weights?: readonly number[]
  /** 预热 closed bars（来自研究 K 线缓存；时间须与实时流衔接） */
  warmupBars?: readonly ShortlineBar[]
}

export interface LiveScoreSample {
  t: number
  scores: Array<number | null>
  combo: number | null
  barStart: number
  stale: false
}

export class LiveScoringEngine {
  readonly #opts: LiveEngineOptions
  readonly #acc = new Accumulator()
  #closedBars: ShortlineBar[] = []
  #maxNeed: number
  #lastClosedBarStart = -1
  #lastBucketTs = -1

  constructor(opts: LiveEngineOptions) {
    this.#opts = opts
    if (opts.warmupBars?.length) {
      this.#closedBars = [...opts.warmupBars]
      this.#lastClosedBarStart = opts.warmupBars[opts.warmupBars.length - 1]!.timeMs
    }
    const spanSec = TIMEFRAME_SECONDS[opts.timeframe]
    const estW = Math.max(200, Math.ceil(86400 / spanSec))
    let need = 0
    for (const ch of opts.champions) {
      need = Math.max(need, requiredHistoryBars(ch.tokens, opts.timeframe, estW))
    }
    this.#maxNeed = need
  }

  /** WS aggTrade 事件入口 */
  onAggTrade(e: AggTradeEvent): void {
    this.#acc.pushEvent(e)
  }

  get buckets(): readonly TickBucket[] {
    return this.#acc.list()
  }

  /**
   * cadence 步打分（t 为网格毫秒时刻，由外部定时器传入）。
   * 返回 null 表示历史不足（warmup 未满）或该步无效。
   */
  onCadence(t: number): LiveScoreSample | null {
    const spanSec = TIMEFRAME_SECONDS[this.#opts.timeframe]
    const span = spanSec * 1000
    const curBarStart = barStartMs(t, spanSec)
    const buckets = this.#acc.list()

    // 收割已 closed 的 bar（start+span ≤ curBarStart 即已完整过去）
    let nextStart = this.#lastClosedBarStart > 0
      ? this.#lastClosedBarStart + span
      : (buckets.length ? barStartMs(buckets[0]!.ts * 1000, spanSec) : -1)
    while (nextStart >= 0 && nextStart + span <= curBarStart) {
      this.#closeBar(nextStart, buckets)
      nextStart += span
    }

    // forming bar at t（严格因果：仅 s+1 ≤ t 的秒桶）
    const cutSecExclusive = Math.floor(t / 1000)
    const fromIdx = firstBucketAtOrAfter(buckets, Math.floor(curBarStart / 1000))
    let to = fromIdx
    while (to < buckets.length && buckets[to]!.ts < cutSecExclusive) to++
    let prevClose = this.#closedBars.length ? this.#closedBars[this.#closedBars.length - 1]!.close : NaN
    const forming = buildFormingBar(buckets, fromIdx, to, curBarStart, t,
      { barSpanSeconds: spanSec, normalizeVolume: true }, prevClose, computeOrderflowRaw)

    const need = this.#maxNeed
    const window = this.#closedBars.length > need
      ? this.#closedBars.slice(this.#closedBars.length - need)
      : this.#closedBars
    if (!window.length) return null
    const { scores } = scoreAtWindow([...window, forming], this.#opts.champions)
    const anyNull = scores.some((s) => s === null)
    return {
      t,
      scores,
      combo: anyNull ? null : comboScore(scores as number[], (this.#opts.weights ?? equalWeights(this.#opts.champions.length)) as number[]),
      barStart: curBarStart,
      stale: false,
    }
  }

  #closeBar(startMs: number, buckets: readonly TickBucket[]): void {
    const spanSec = TIMEFRAME_SECONDS[this.#opts.timeframe]
    const from = firstBucketAtOrAfter(buckets, Math.floor(startMs / 1000))
    const endSec = Math.floor((startMs + spanSec * 1000) / 1000)
    let to = from
    while (to < buckets.length && buckets[to]!.ts < endSec) to++
    const prevClose = this.#closedBars.length ? this.#closedBars[this.#closedBars.length - 1]!.close : NaN
    const bar = buildFormingBar(buckets, from, to, startMs, startMs + spanSec * 1000,
      { barSpanSeconds: spanSec, normalizeVolume: true }, prevClose, computeOrderflowRaw)
    this.#closedBars.push(bar)
    this.#lastClosedBarStart = startMs
    this.#lastBucketTs = to > from ? buckets[to - 1]!.ts : this.#lastBucketTs
    const cap = this.#maxNeed * 2 + 16
    if (this.#closedBars.length > cap) this.#closedBars.splice(0, this.#closedBars.length - cap)
  }
}

function firstBucketAtOrAfter(buckets: readonly TickBucket[], sec: number): number {
  let lo = 0, hi = buckets.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (buckets[mid]!.ts < sec) lo = mid + 1
    else hi = mid
  }
  return lo
}

function equalWeights(n: number): number[] {
  return Array.from({ length: n }, () => 1 / Math.max(1, n))
}

export type { BucketAccumulator }
