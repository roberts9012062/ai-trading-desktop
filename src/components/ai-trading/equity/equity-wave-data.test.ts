import { describe, expect, it } from "vitest"
import type { AITradingTask } from "@/lib/ai-trading-api"
import { updateEquityTraces, compactWaveSamples, bezierSegments, waveTimeRange, wavePath } from "./equity-wave-data"

const start = Date.parse("2026-10-03T15:59:58Z")
function task(overrides: Partial<AITradingTask> = {}): AITradingTask {
  return { id: "one", user_id: "owner", symbol: "btcusdt", funding_source: "live", position_direction: "long", position_qty: 1, has_open_position: true, position_opened_at: new Date(start).toISOString(), position_unrealized: -1.32, ...overrides } as AITradingTask
}
describe("current position trajectories", () => {
  it("begins at the actual first observation, never at midnight or synthetic zero", () => {
    const traces = updateEquityTraces({}, [task()], start + 1000)
    expect(traces.one.samples).toEqual([{ time: start + 1000, value: -1.32 }])
  })
  it("retains every observed turn, including across midnight and partial position changes", () => {
    let traces = updateEquityTraces({}, [task()], start + 1000)
    traces = updateEquityTraces(traces, [task({ position_qty: 2, position_avg_price: 120, position_unrealized: 3 })], start + 2000)
    traces = updateEquityTraces(traces, [task({ position_qty: .5, position_unrealized: 1 })], start + 3000)
    expect(traces.one.samples.map(p => p.value)).toEqual([-1.32, 3, 1])
    expect(traces.one.samples[0].time).toBe(start + 1000)
  })
  it("deletes a confirmed full close, rejects stale flags and starts fresh on reopening", () => {
    const traces = updateEquityTraces({}, [task()], start + 1000)
    const closed = updateEquityTraces(traces, [task({ position_qty: 0, position_direction: null, has_open_position: false })], start + 2000)
    expect(closed).toEqual({})
    const reopened = updateEquityTraces(traces, [task({ position_opened_at: new Date(start + 2000).toISOString(), position_unrealized: 2 })], start + 3000)
    expect(reopened.one.samples).toEqual([{ time: start + 3000, value: 2 }])
    expect(updateEquityTraces(traces, [task({ position_qty: 0, has_open_position: true })], start + 2000)).toEqual(traces)
  })
  it("does not fabricate zero on missing/nonfinite pnl; disconnects across missing observations", () => {
    let traces = updateEquityTraces({}, [task()], start + 1000)
    for (const value of [null, undefined, NaN, Infinity]) {
      traces = updateEquityTraces(traces, [task({ position_unrealized: value })], start + 2000)
    }
    expect(traces.one.samples).toHaveLength(1)
    traces = updateEquityTraces(traces, [task({ position_unrealized: 5 })], start + 40000)
    expect(traces.one.samples[1].breakBefore).toBe(true)
  })
  it("resets on direction/symbol changes but not a model switch", () => {
    const traces = updateEquityTraces({}, [task()], start + 1000)
    expect(updateEquityTraces(traces, [task({ model_id: "other" })], start + 2000).one.samples).toHaveLength(2)
    expect(updateEquityTraces(traces, [task({ position_direction: "short" })], start + 2000).one.samples).toHaveLength(1)
    expect(updateEquityTraces(traces, [task({ symbol: "ethusdt" })], start + 2000).one.samples).toHaveLength(1)
  })
  it("does not join unidentifiable old positions across an offline gap", () => {
    let traces = updateEquityTraces({}, [task({ position_opened_at: null })], start + 1000)
    traces = updateEquityTraces(traces, [task({ position_opened_at: null, position_unrealized: 5 })], start + 30000)
    expect(traces.one.samples).toEqual([{ time: start + 30000, value: 5 }])
  })
  it("ignores old observation responses and deduplicates equal timestamps", () => {
    const traces = updateEquityTraces({}, [task()], start + 3000)
    expect(updateEquityTraces(traces, [task({ position_unrealized: 4 })], start + 2000)).toEqual(traces)
    expect(updateEquityTraces(traces, [task({ position_unrealized: 4 })], start + 3000).one.samples).toEqual([{ time: start + 3000, value: 4 }])
  })
  it("bounds storage and preserves endpoints and the observed extremes", () => {
    const samples = Array.from({ length: 10000 }, (_, i) => ({ time: start + i * 1000, value: Math.sin(i / 100) }))
    samples[426].value = -100
    samples[7876].value = 200
    const result = compactWaveSamples(samples, 1000)
    expect(result.length).toBeLessThanOrEqual(1000)
    expect(result[0]).toEqual(samples[0])
    expect(result.at(-1)).toEqual(samples.at(-1))
    expect(Math.min(...result.map(p => p.value))).toBe(-100)
    expect(Math.max(...result.map(p => p.value))).toBe(200)
  })
  it("preserves disconnections even when compressing a bucket with a removed boundary sample", () => {
    const samples = Array.from({ length: 10000 }, (_, i) => ({ time: start + i * 1000, value: Math.sin(i / 100), breakBefore: i % 23 === 0 }))
    const reduced = compactWaveSamples(samples, 1000)
    expect(reduced.length).toBeLessThanOrEqual(1000)
    for (let i = 1; i < reduced.length; i++) {
      const a = (reduced[i - 1].time - start) / 1000, b = (reduced[i].time - start) / 1000
      if (samples.slice(a + 1, b + 1).some(p => p.breakBefore)) expect(reduced[i].breakBefore).toBe(true)
    }
  })
  it("draws separate Bezier subpaths across a missing-data gap", () => {
    const path = wavePath([{ time: 0, value: 1 }, { time: 1, value: 2 }, { time: 30, value: 5, breakBefore: true }, { time: 31, value: 6 }], t => t * 10, v => v)
    expect(path.match(/M /g)).toHaveLength(2)
    expect(path.match(/C /g)).toHaveLength(2)
    expect(path).toContain("M 300 5")
  })
})
describe("shape preserving cubic Bezier waves", () => {
  it("passes through all real samples and never invents a higher peak or lower trough", () => {
    const points = [{ x: 0, y: 0 }, { x: 10, y: 9 }, { x: 100, y: -5 }, { x: 101, y: 4 }, { x: 200, y: 4 }]
    const segments = bezierSegments(points)
    expect(segments).toHaveLength(4)
    for (const [i, s] of segments.entries()) {
      expect(s.from).toEqual(points[i]); expect(s.to).toEqual(points[i + 1])
      for (let j = 0; j <= 100; j++) {
        const t = j / 100, u = 1 - t
        const y = u ** 3 * s.from.y + 3 * u ** 2 * t * s.c1.y + 3 * u * t ** 2 * s.c2.y + t ** 3 * s.to.y
        expect(y).toBeGreaterThanOrEqual(Math.min(s.from.y, s.to.y) - 1e-10)
        expect(y).toBeLessThanOrEqual(Math.max(s.from.y, s.to.y) + 1e-10)
      }
    }
  })
  it("uses the sample interval rather than the calendar day", () => {
    const range = waveTimeRange([{ time: start, value: 1 }, { time: start + 1000, value: 2 }])
    expect(range.from).toBe(start)
    expect(range.to).toBeGreaterThan(start + 1000)
    expect(range.to - range.from).toBeLessThanOrEqual(60000)
  })
  it("does not create an extra reversal between monotonically increasing real samples", () => {
    const points = [{ x: 0, y: -100 }, { x: 20, y: 0 }, { x: 21, y: .01 }, { x: 22, y: 100 }, { x: 500, y: 200 }]
    for (const s of bezierSegments(points)) {
      let previous = s.from.y
      for (let j = 1; j <= 100; j++) {
        const t = j / 100, u = 1 - t
        const y = u ** 3 * s.from.y + 3 * u ** 2 * t * s.c1.y + 3 * u * t ** 2 * s.c2.y + t ** 3 * s.to.y
        expect(y).toBeGreaterThanOrEqual(previous - 1e-10)
        previous = y
      }
    }
  })
})
