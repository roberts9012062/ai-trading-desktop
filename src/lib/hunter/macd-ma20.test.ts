import { describe, it, expect } from "vitest"
import fixture from "./macd-ma20-fixtures.json"
import { macdMa20Entry, MACD_PERIODS, type MacdPeriod } from "./macd-ma20"
import type { Bar } from "./rules"

export function macdFixture(count: number, period: MacdPeriod, now = fixture.now): Bar[] {
  const prices = fixture.prices[String(count) as keyof typeof fixture.prices]
  const seconds = MACD_PERIODS[period], close = Math.floor(now/seconds)*seconds
  return prices.map((p, i)=>[(close-(prices.length-i)*seconds)*1000, p, p+.1, p-.1, p, 100])
}

describe("MACD new cross with the complete MA20 entry window", () => {
  for (const period of ["30m", "60m"] as MacdPeriod[]) {
    for (const count of [2,3,4,5]) it(`${period}: ${count} consecutive candles ${count===3 || count===4 ? "accepted" : "rejected"}`, () => {
      const signal = macdMa20Entry(macdFixture(count,period),period,fixture.now)
      expect(Boolean(signal)).toBe(count===3 || count===4)
      if (signal) expect(signal.above_count).toBe(count)
    })
  }
  it("ignores an unfinished cross and stale/gapped OHLC data", () => {
    const bars = macdFixture(3,"30m")
    expect(macdMa20Entry(bars,"30m",fixture.now-1)).toBeNull()
    expect(macdMa20Entry(bars,"30m",fixture.now+1800)).toBeNull()
    expect(macdMa20Entry([...bars.slice(0,50),...bars.slice(51)],"30m",fixture.now)).toBeNull()
    expect(macdMa20Entry(bars.slice(0,90),"30m",fixture.now)).toBeNull()
  })
})
