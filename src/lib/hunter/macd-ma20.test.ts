import { describe, it, expect } from "vitest"
import fixture from "./macd-ma20-fixtures.json"
import aave from "./aave-okx-entry-fixture.json"
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
  it("rejects the actual AAVE entry with three closes above MA20 but only two bodies", () => {
    expect(macdMa20Entry(aave.rows.map(row => row.slice(0,6) as Bar), "30m", aave.signal_at + 4)).toBeNull()
  })
  for (const period of ["30m", "60m"] as MacdPeriod[]) {
    it(`${period}: rejects a crossing or touching body and permits a lower wick`, () => {
      const rows = macdFixture(3, period), i = rows.length - 3
      const ma = rows.slice(i-19,i+1).reduce((s,b)=>s+b[4],0)/20
      rows[i][1] = ma-.01; rows[i][3] = Math.min(rows[i][3],rows[i][1]-.01)
      expect(macdMa20Entry(rows, period, fixture.now)).toBeNull()
      rows[i][1] = ma
      expect(macdMa20Entry(rows, period, fixture.now)).toBeNull()
      rows[i][1] = rows[i][4]
      expect(macdMa20Entry(rows, period, fixture.now)?.above_basis).toBe("body")
    })
  }
})
