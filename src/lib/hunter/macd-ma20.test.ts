import { describe, it, expect } from "vitest"
import fixture from "./macd-ma20-fixtures.json"
import aave from "./aave-okx-entry-fixture.json"
import { macdMa20Entry, macdMa20ShortEntry, reboundLongEntry, reboundShortEntry, MACD_PERIODS, type MacdPeriod } from "./macd-ma20"
import type { Bar } from "./rules"

export function macdFixture(count: number, period: MacdPeriod, now = fixture.now): Bar[] {
  const prices = fixture.prices[String(count) as keyof typeof fixture.prices]
  const seconds = MACD_PERIODS[period], close = Math.floor(now/seconds)*seconds
  return prices.map((p, i)=>[(close-(prices.length-i)*seconds)*1000, p, p+.1, p-.1, p, 100])
}

// Mirror every OHLC value around 300: a bullish fixture becomes a bearish one.
function mirrored(rows: Bar[]): Bar[] {
  return rows.map(b=>[b[0], 300-b[1], 300-b[3], 300-b[2], 300-b[4], b[5]] as Bar)
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

describe("MACD dead-cross short with the 2-3 body window under MA20", () => {
  for (const period of ["30m", "60m"] as MacdPeriod[]) {
    for (const count of [2,3,4,5]) it(`${period}: ${count} consecutive bodies below ${count===2 || count===3 ? "accepted" : "rejected"}`, () => {
      const signal = macdMa20ShortEntry(mirrored(macdFixture(count,period)),period,fixture.now)
      expect(Boolean(signal)).toBe(count===2 || count===3)
      if (signal) expect(signal.below_count).toBe(count)
    })
  }
  it("ignores unfinished, stale or gapped OHLC data", () => {
    const rows = mirrored(macdFixture(2,"30m"))
    expect(macdMa20ShortEntry(rows,"30m",fixture.now-1)).toBeNull()
    expect(macdMa20ShortEntry(rows,"30m",fixture.now+1800)).toBeNull()
    expect(macdMa20ShortEntry([...rows.slice(0,50),...rows.slice(51)],"30m",fixture.now)).toBeNull()
    expect(macdMa20ShortEntry(rows.slice(0,90),"30m",fixture.now)).toBeNull()
  })
  it("keeps a stale dead-cross regime valid once a second body closes", () => {
    const seconds = MACD_PERIODS["30m"]
    const rows = mirrored(macdFixture(2,"30m")), last = rows[rows.length-1]
    const close = last[4]-.2
    rows.push([last[0]+seconds*1000, close, close+.1, close-.1, close, 100])
    expect(macdMa20ShortEntry(rows,"30m",fixture.now+seconds)?.below_count).toBe(3)
  })

  it("rejects shorts whose MA20 gap exceeds 4% of margin at the given leverage", () => {
    const rows = mirrored(macdFixture(2,"30m")), last = rows.length-1
    const ma = rows.slice(last-19,last+1).reduce((s,b)=>s+b[4],0)/20
    const ratio = (ma-rows[last][1])/rows[last][1]
    expect(Boolean(macdMa20ShortEntry(rows,"30m",fixture.now,5))).toBe(ratio*5 <= .04)
    expect(macdMa20ShortEntry(rows,"30m",fixture.now,10)).toBeNull()  // ~0.43% x 10 breaches 4%
    expect(macdMa20ShortEntry(rows,"30m",fixture.now,1)?.ma20_gap).toBeCloseTo(ma-rows[last][1], 10)
    expect(macdMa20ShortEntry(rows,"30m",fixture.now)).toBeTruthy()  // no leverage keeps the guard off
  })

  for (const period of ["30m", "60m"] as MacdPeriod[]) {
    it(`${period}: rejects a crossing or touching body but permits an upper wick`, () => {
      const rows = mirrored(macdFixture(2, period)), i = rows.length - 2
      const ma = rows.slice(i-19,i+1).reduce((s,b)=>s+b[4],0)/20
      rows[i][1] = ma+.01; rows[i][2] = Math.max(rows[i][2],rows[i][1]+.01)
      expect(macdMa20ShortEntry(rows, period, fixture.now)).toBeNull()
      rows[i][1] = ma
      expect(macdMa20ShortEntry(rows, period, fixture.now)).toBeNull()
      rows[i][1] = rows[i][4]
      expect(macdMa20ShortEntry(rows, period, fixture.now)?.below_basis).toBe("body")
    })
  }
})

function reboundBars(c1: [number, number], c2: [number, number], c3?: [number, number], seconds = 1800, count = 110, now = fixture.now, start = 100) {
  const shaped = c3 ? [c1, c2, c3] : [c1, c2]
  const rows: Bar[] = []
  for (let i = 0; i < count; i++) rows.push([(now-(count+shaped.length-i)*seconds)*1000, start, start+.05, start-.05, start, 10] as Bar)
  shaped.forEach(([o, c], i) => {
    rows.push([(now-(shaped.length-i)*seconds)*1000, o, Math.max(o, c)+.05, Math.min(o, c)-.05, c, 10] as Bar)
  })
  return rows
}

describe("rebound hunter entries", () => {
  it("longs at the second close: the order lives only through the third candle", () => {
    const crash = reboundBars([100, 95], [95, 89.5])
    const signal = reboundLongEntry(crash, "30m", fixture.now)
    expect(signal?.direction).toBe("long")
    expect(signal?.thrust).toBeCloseTo(10.5, 6)
    expect(signal?.signal_at).toBe(fixture.now)         // close of the second red candle
    expect(signal?.expires_at).toBe(fixture.now + 1800) // end of the third candle
    expect(reboundLongEntry(crash, "30m", fixture.now - 1)).toBeNull()
    expect(reboundLongEntry(crash, "30m", fixture.now + 1800)).toBeNull()
    expect(reboundLongEntry(reboundBars([100, 101], [101, 89.5]), "30m", fixture.now)).toBeNull()
    expect(reboundLongEntry(reboundBars([100, 96], [96, 92]), "30m", fixture.now)).toBeNull()
    expect(reboundLongEntry(reboundBars([100, 96], [96, 92]), "30m", fixture.now, .07)).toBeTruthy()
  })
  it("shorts only when the third candle fades and nears MA20", () => {
    expect(reboundShortEntry(reboundBars([100, 106], [106, 111], [111, 110.9]), "30m", fixture.now)).toBeTruthy()
    expect(reboundShortEntry(reboundBars([100, 106], [106, 111], [111, 116]), "30m", fixture.now)).toBeNull()
  })
  it("ignores stale or gapped data", () => {
    const crash = reboundBars([100, 95], [95, 89.5])
    expect(reboundLongEntry([...crash.slice(0, 50), ...crash.slice(51)], "30m", fixture.now)).toBeNull()
  })
})
