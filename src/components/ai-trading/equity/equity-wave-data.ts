import type { AITradingTask } from "@/lib/ai-trading-api"
import { toUnixSec } from "./equity-time"

export interface WaveSample { time: number; value: number; breakBefore?: boolean }
export interface EquityTrace { positionKey: string; openedAt: number | null; samples: WaveSample[] }
export type EquityTraces = Record<string, EquityTrace>
export const MAX_WAVE_SAMPLES = 1800
export const WAVE_GAP_MS = 15000

/** Contradictory/missing position fields are unknown, never confirmation of a close. */
export function wavePositionStatus(task: AITradingTask): "open" | "flat" | "unknown" {
  if (task.position_sync_status) return "unknown"
  const qty = task.position_qty
  if (qty != null && Number.isFinite(qty)) {
    if (qty > 0 && (task.position_direction === "long" || task.position_direction === "short")) return "open"
    if (qty === 0 && task.has_open_position !== true) return "flat"
    return "unknown"
  }
  if (task.has_open_position === false) return "flat"
  return "unknown"
}

export function wavePositionKey(task: AITradingTask): string {
  return JSON.stringify([task.id, task.symbol, task.funding_source, task.position_direction, task.position_opened_at ?? null])
}

/** Retain actual first/last and bucket min/max observations; never average the profit. */
export function compactWaveSamples(samples: WaveSample[], limit = MAX_WAVE_SAMPLES): WaveSample[] {
  if (samples.length <= limit) return samples
  const bucketCount = Math.max(1, Math.floor((limit - 2) / 2))
  const result = [samples[0]]
  let lastRetainedIndex = 0
  for (let b = 0; b < bucketCount; b++) {
    const from = 1 + Math.floor(b * (samples.length - 2) / bucketCount)
    const to = 1 + Math.floor((b + 1) * (samples.length - 2) / bucketCount)
    let low = from, high = from
    for (let i = from; i < to; i++) {
      if (samples[i].value < samples[low].value) low = i
      if (samples[i].value > samples[high].value) high = i
    }
    for (const i of [...new Set([low, high])].sort((a, b) => a - b)) {
      // A bucket containing a missing-data boundary must not bridge that boundary.
      const hasGap = samples.slice(lastRetainedIndex + 1, i + 1).some(p => p.breakBefore)
      result.push(hasGap ? { ...samples[i], breakBefore: true } : samples[i])
      lastRetainedIndex = i
    }
  }
  const last = samples[samples.length - 1]
  result.push(samples.slice(lastRetainedIndex + 1).some(p => p.breakBefore) ? { ...last, breakBefore: true } : last)
  return result
}

/** Only call for successful authoritative task-list responses, not renders/hover/errors. */
export function updateEquityTraces(previous: EquityTraces, tasks: AITradingTask[], now: number): EquityTraces {
  const next: EquityTraces = {}
  for (const task of tasks) {
    const old = previous[task.id]
    const state = wavePositionStatus(task)
    if (state === "flat") continue
    if (state === "unknown") { if (old) next[task.id] = old; continue }
    const key = wavePositionKey(task)
    const openedSec = toUnixSec(task.position_opened_at ?? "")
    const openedAt = openedSec === null ? null : openedSec * 1000
    const unknownEpochGap = openedAt === null && old?.samples.length && now - old.samples[old.samples.length - 1].time > WAVE_GAP_MS
    const trace: EquityTrace = old?.positionKey === key && !unknownEpochGap ? old : { positionKey: key, openedAt, samples: [] }
    const last = trace.samples[trace.samples.length - 1]
    if (!Number.isFinite(now) || (last && now < last.time)) { next[task.id] = trace; continue }
    const value = task.position_unrealized
    // null/undefined and NaN must not coerce to zero.
    if (value == null || !Number.isFinite(value) || (openedAt !== null && now < openedAt)) {
      next[task.id] = trace; continue
    }
    const sample: WaveSample = { time: now, value }
    if (last && now - last.time > WAVE_GAP_MS) sample.breakBefore = true
    const samples = last?.time === now ? [...trace.samples.slice(0, -1), { ...sample, breakBefore: last.breakBefore }] : [...trace.samples, sample]
    next[task.id] = { ...trace, samples: compactWaveSamples(samples) }
  }
  return next
}

export function waveTimeRange(samples: WaveSample[]): { from: number; to: number } {
  if (!samples.length) return { from: 0, to: 60000 }
  let from = Infinity, last = -Infinity
  for (const sample of samples) { from = Math.min(from, sample.time); last = Math.max(last, sample.time) }
  return { from, to: last + Math.max(30000, (last - from) * .06) }
}

export interface WaveCoordinate { x: number; y: number }
export interface BezierSegment { from: WaveCoordinate; c1: WaveCoordinate; c2: WaveCoordinate; to: WaveCoordinate }

/** Monotone Hermite converted to cubic Bezier. Control points stay in each sample interval. */
export function bezierSegments(points: WaveCoordinate[]): BezierSegment[] {
  if (points.length < 2) return []
  const slopes = points.slice(1).map((p, i) => (p.y - points[i].y) / (p.x - points[i].x))
  const tangents = points.map((_, i) => {
    if (i === 0) return slopes[0]
    if (i === points.length - 1) return slopes[slopes.length - 1]
    const a = slopes[i - 1], b = slopes[i]
    if (a * b <= 0) return 0
    const h0 = points[i].x - points[i - 1].x, h1 = points[i + 1].x - points[i].x
    const w1 = 2 * h1 + h0, w2 = h1 + 2 * h0
    return (w1 + w2) / (w1 / a + w2 / b)
  })
  return slopes.map((_, i) => {
    const from = points[i], to = points[i + 1], dx = (to.x - from.x) / 3
    const clamp = (y: number) => Math.min(Math.max(y, Math.min(from.y, to.y)), Math.max(from.y, to.y))
    return { from, c1: { x: from.x + dx, y: clamp(from.y + dx * tangents[i]) }, c2: { x: to.x - dx, y: clamp(to.y - dx * tangents[i + 1]) }, to }
  })
}

export function wavePath(samples: WaveSample[], x: (time: number) => number, y: (value: number) => number): string {
  const groups: WaveSample[][] = []
  for (const sample of samples) {
    if (!groups.length || sample.breakBefore) groups.push([])
    groups[groups.length - 1].push(sample)
  }
  return groups.map(group => {
    const points = group.map(p => ({ x: x(p.time), y: y(p.value) }))
    const first = points[0]
    return `M ${first.x} ${first.y}` + bezierSegments(points).map(s => ` C ${s.c1.x} ${s.c1.y} ${s.c2.x} ${s.c2.y} ${s.to.x} ${s.to.y}`).join("")
  }).join(" ")
}
