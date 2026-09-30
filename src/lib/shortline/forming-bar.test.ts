import { describe, expect, it } from "vitest"
import type { TickBucket } from "./digest"
import { barStartMs, buildFormingBar } from "./forming-bar"
import { computeOrderflowRaw } from "./orderflow"

const span = 60 // 1m
const opts = { barSpanSeconds: span, normalizeVolume: true }
const of = (w: readonly TickBucket[], scale: number) => computeOrderflowRaw(w, scale)

function bucket(ts: number, price: number, vol: number, tb: number): TickBucket {
  return { ts, open: price, high: price, low: price, close: price, vol, quote: price * vol, takerBuyVol: tb, takerBuyQuote: tb * price, count: 1 }
}

describe("buildFormingBar（forming-bar-spec/1）", () => {
  it("cut 截断：只含已完整过去的秒桶", () => {
    const buckets = [bucket(0, 100, 1, 1), bucket(30, 110, 2, 0), bucket(59, 120, 3, 1)]
    // cut = 30s → 只见桶 0
    const bar = buildFormingBar(buckets, 0, 1, 0, 30_000, opts, NaN, of)
    expect(bar.close).toBe(100)
    expect(bar.volume).toBeCloseTo(2, 12) // 1 × (60/30)
    expect(bar.forming).toBe(true)
  })

  it("closed bar：scale=1，不归一", () => {
    const buckets = [bucket(0, 100, 1, 1), bucket(30, 110, 2, 0)]
    const bar = buildFormingBar(buckets, 0, 2, 0, 60_000, opts, NaN, of)
    expect(bar.volume).toBe(3)
    expect(bar.forming).toBe(false)
    expect(bar.sl.length).toBe(8)
  })

  it("无交易 bar：价格前向填充，量为 0", () => {
    const buckets = [bucket(0, 100, 1, 1)]
    const bar = buildFormingBar(buckets, 0, 0, 60_000, 120_000, opts, 99.5, of)
    expect(bar.open).toBe(99.5)
    expect(bar.high).toBe(99.5)
    expect(bar.close).toBe(99.5)
    expect(bar.volume).toBe(0)
    expect(bar.sl[0]).toBe(0)
  })

  it("量时间归一：半根 elapsed=30 → 量×2", () => {
    const buckets = Array.from({ length: 30 }, (_, i) => bucket(i, 100, 1, 1))
    const half = buildFormingBar(buckets, 0, 30, 0, 30_000, opts, NaN, of)
    expect(half.volume).toBeCloseTo(60, 9)
    expect(half.tradeCount).toBeCloseTo(60, 9)
    const full = buildFormingBar(buckets, 0, 30, 0, 60_000, opts, NaN, of)
    // full 只含 30 个桶的量×1（无后续桶）
    expect(full.volume).toBe(30)
  })

  it("elapsed 下限 1 秒（cut=0 时）", () => {
    const buckets = [bucket(0, 100, 5, 5)]
    // cut = barStart+0 → 桶 0 不可见（严格因果），elapsed 钳到 1
    const bar = buildFormingBar(buckets, 0, 0, 0, 0, opts, 100, of)
    expect(bar.volume).toBe(0)
  })

  it("OHLC 聚合正确", () => {
    const buckets = [bucket(0, 100, 1, 1), bucket(1, 90, 1, 1), bucket(2, 120, 1, 1), bucket(3, 105, 1, 1)]
    const bar = buildFormingBar(buckets, 0, 4, 0, 60_000, opts, NaN, of)
    expect(bar.open).toBe(100)
    expect(bar.high).toBe(120)
    expect(bar.low).toBe(90)
    expect(bar.close).toBe(105)
  })
})

describe("barStartMs", () => {
  it("UTC 周期对齐", () => {
    expect(barStartMs(61_000, 60)).toBe(60_000)
    expect(barStartMs(899_999, 300)).toBe(600_000)
    expect(barStartMs(900_000, 300)).toBe(900_000)
  })
})
