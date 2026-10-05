import { beforeEach, expect, it, vi } from "vitest"
import { clearRtAccumulator, offerRtBar, readRtTail, rtAccKey } from "./accumulator"
import { listActiveRtKeys } from "./accumulator"
import { mergeBarsWithRealtime, resolveHoveredBar } from "../utils"

beforeEach(() => clearRtAccumulator())

it("rejects legacy and spot frames before they can pollute OKX highs and lows", () => {
  const bar = { time: "2026-10-05 08:00:00", open: 1.2, high: 1.21, low: 1.19, close: 1.2052, volume: 30 }
  offerRtBar("dotusdt", "60m", { ...bar, market_source: "okx", version: 10, kind: "correction" })
  offerRtBar("dotusdt", "60m", { ...bar, high: 2, low: 1, version: 999 })
  offerRtBar("dotusdt", "60m", { ...bar, market_source: "binance_spot", high: 3, version: 1000 })
  expect(readRtTail(rtAccKey("dotusdt", "60m"), "")).toEqual([{ ...bar, market_source: "okx", version: 10, kind: "correction" }])
})

it("accepts authoritative corrections and preserves non-crypto feeds", () => {
  const bar = { time: "2026-10-05 08:00:00", open: 100, high: 110, low: 90, close: 102, volume: 30 }
  offerRtBar("dotusdt", "60m", { ...bar, market_source: "okx", version: 10, kind: "correction" })
  offerRtBar("dotusdt", "60m", { ...bar, high: 104, low: 99, market_source: "okx", version: 11, kind: "correction" })
  expect(readRtTail(rtAccKey("dotusdt", "60m"), "")[0].high).toBe(104)
  offerRtBar("rb2610", "60m", bar)
  expect(readRtTail(rtAccKey("rb2610", "60m"), "")).toEqual([bar])
})

it("ignores a fallback frame during chart rebuild and hover", () => {
  const bar = { time: "2026-10-05 08:00:00", open: 100, high: 102, low: 99, close: 101, volume: 30, market_source: "okx" as const }
  const fallback = { ...bar, time: "2026-10-05 09:00:00", high: 200, market_source: "binance_spot" as const }
  expect(mergeBarsWithRealtime([bar], fallback, "60m")).toEqual([bar])
  expect(resolveHoveredBar(1, [bar], fallback, "60m")).toBeNull()
})

it("only consumers keep a polling subscription alive", () => {
  vi.useFakeTimers()
  try {
    readRtTail(rtAccKey("dotusdt", "60m"), "")
    expect(listActiveRtKeys(30_000)).toEqual([{ symbol: "dotusdt", period: "60m" }])
    vi.advanceTimersByTime(31_000)
    offerRtBar("dotusdt", "60m", { time: "2026-10-05 08:00:00", open: 100, high: 102, low: 99, close: 101, volume: 30, market_source: "okx" })
    expect(listActiveRtKeys(30_000)).toEqual([])
  } finally { vi.useRealTimers() }
})
