import { describe, expect, it, vi } from "vitest"
import { intradayDayStart, loadIntradayHistory, mergeIntraday } from "./intraday"
import { cryptoDepthStats, formatCoinQuantity } from "../crypto-depth"
import type { KlineBar } from "@/types"
import type { QuoteData } from "@/lib/websocket"

const now = Date.parse("2026-10-10T00:02:30+08:00") / 1000
const bar = (time: string, close = 1): KlineBar => ({ time, open: close, high: close, low: close, close, volume: 0, market_source: "okx" })

describe("crypto intraday", () => {
  it("rolls over at Beijing midnight independent of machine timezone", () => {
    expect(new Date(intradayDayStart(now) * 1000).toISOString()).toBe("2026-10-09T16:00:00.000Z")
    expect(intradayDayStart(now - 180)).toBe(intradayDayStart(now) - 86400)
  })
  it("keeps one sorted point per minute, drops yesterday, future and invalid prices", () => {
    expect(mergeIntraday([{ time: now - 60, value: 1 }], [
      { time: now - 55, value: 2 }, { time: now - 200, value: 3 },
      { time: now + 100, value: 4 }, { time: now, value: NaN }, { time: now, value: -1 },
    ], now)).toEqual([{ time: Math.floor((now - 60) / 60) * 60, value: 2 }])
  })
  it("pages until midnight and retains real minute closes", async () => {
    const fetch = vi.fn().mockResolvedValueOnce({ bars: [bar("2026-10-10 00:02:00", 3)], has_more: true })
      .mockResolvedValueOnce({ bars: [bar("2026-10-09 23:59:00"), bar("2026-10-10 00:00:00", 2)], has_more: true })
    const result = await loadIntradayHistory(fetch, now)
    expect(fetch.mock.calls[1][0]).toEqual({ limit: 100, endTime: "2026-10-10 00:02:00" })
    expect(result.complete).toBe(true)
    expect(result.points.map(p => p.value)).toEqual([2, 3])
    expect(result.points[0].time).toBe(intradayDayStart(now))
  })
  it("retains partial history on failure and stops non-advancing pagination", async () => {
    const page = { bars: [bar("2026-10-10 00:02:00")], has_more: true }
    const failing = vi.fn().mockResolvedValueOnce(page).mockRejectedValue(new Error("429"))
    expect(await loadIntradayHistory(failing, now)).toMatchObject({ complete: false, points: [{ value: 1 }] })
    const stalled = vi.fn().mockResolvedValue(page)
    expect((await loadIntradayHistory(stalled, now)).complete).toBe(false)
    expect(stalled).toHaveBeenCalledTimes(2)
  })
  it("never substitutes a different exchange's candles", async () => {
    const result = await loadIntradayHistory(async () => ({ bars: [{ ...bar("2026-10-10 00:00:00"), market_source: "gate_usdt" }], has_more: false }), now)
    expect(result.points).toEqual([])
  })
})

describe("crypto depth", () => {
  it("uses 24h metrics and preserves fractional base coin quantities", () => {
    const result = cryptoDepthStats({ open_price: 100, high_price: 120, low_price: 90, volume: 0.00015, position: 9999, change_pct: 10 } as QuoteData, 0.01)
    expect(result.amplitude.value).toBe(30)
    expect(result.volume.value).toBe(0.00015)
    expect(result).not.toHaveProperty("open_interest")
    expect(result).not.toHaveProperty("pre_settlement_price")
    expect(formatCoinQuantity(0.00015)).toBe("0.00015")
    expect(formatCoinQuantity(undefined)).toBe("--")
  })
  it("shows unavailable data as missing instead of a fabricated zero", () => {
    expect(cryptoDepthStats(undefined, null).last.value).toBeNull()
    expect(cryptoDepthStats({ open_price: 0 } as QuoteData, null).amplitude.value).toBeNull()
  })
})
