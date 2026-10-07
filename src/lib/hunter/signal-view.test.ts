import { describe, it, expect } from "vitest"
import fixture from "./macd-ma20-fixtures.json"
import { buildSignalView } from "./signal-view"
import { MACD_PERIODS, type MacdPeriod } from "./macd-ma20"
import type { Bar } from "./rules"

function rows(count: number, period: MacdPeriod, now = fixture.now): Bar[] {
  const prices = fixture.prices[String(count) as keyof typeof fixture.prices]
  const seconds = MACD_PERIODS[period], close = Math.floor(now/seconds)*seconds
  return prices.map((p, i)=>[(close-(prices.length-i)*seconds)*1000, p, p+.1, p-.1, p, 100])
}
const mirrored = (bars: Bar[]): Bar[] => bars.map(b=>[b[0], 300-b[1], 300-b[3], 300-b[2], 300-b[4], b[5]])

describe("signal view chart model", () => {
  for (const period of ["30m", "60m"] as MacdPeriod[]) {
    it(`${period}: outlines the exact long streak and flags every condition`, () => {
      const view = buildSignalView(rows(3, period), period, fixture.now)
      expect(view.streakSide).toBe("long")
      expect(view.streakCount).toBe(3)
      expect(view.streakFrom).toBe(view.points.length-3)
      expect(view.longSignal).toBe(true)
      expect(view.macdFreshGolden).toBe(true)
      expect(view.maRising).toBe(true)
      const outlined = view.points.slice(view.streakFrom!)
      for (const p of outlined) {
        expect(Math.min(p.open, p.close)).toBeGreaterThan(p.ma20!)
      }
    })
    it(`${period}: outlines the short streak on mirrored data`, () => {
      const view = buildSignalView(mirrored(rows(2, period)), period, fixture.now)
      expect(view.streakSide).toBe("short")
      expect(view.streakCount).toBe(2)
      expect(view.streakFrom).toBe(view.points.length-2)
      expect(view.shortSignal).toBe(true)
      expect(view.longSignal).toBe(false)
      expect(view.macdDead).toBe(true)
      expect(view.maFalling).toBe(true)
      for (const p of view.points.slice(view.streakFrom!)) {
        expect(Math.max(p.open, p.close)).toBeLessThan(p.ma20!)
      }
    })
  }
  it("stops the streak at a touching body and clamps the lookback window", () => {
    const bars = rows(3, "30m"), i = bars.length-3
    const ma = bars.slice(i-19, i+1).reduce((s,b)=>s+b[4],0)/20
    bars[i][1] = ma // body touches MA20: streak restarts at 2
    const view = buildSignalView(bars, "30m", fixture.now)
    expect(view.streakSide).toBe("long")
    expect(view.streakCount).toBe(2)
    expect(view.streakFrom).toBe(view.points.length-2)
    const short = buildSignalView(mirrored(rows(3, "30m")), "30m", fixture.now, 2)
    expect(short.points.length).toBe(2)
    expect(short.streakCount).toBe(3)
    expect(short.streakFrom).toBe(0) // clamped, never negative
  })
  it("marks a beyond-window streak without claiming an entry signal", () => {
    const view = buildSignalView(rows(5, "30m"), "30m", fixture.now)
    expect(view.streakSide).toBe("long")
    expect(view.streakCount).toBe(5)
    expect(view.longSignal).toBe(false) // 5 bodies exceeds the 3-4 window
  })
})
