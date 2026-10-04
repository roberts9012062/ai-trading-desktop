import { expect, it } from "vitest"
import { waveDayRange, dayWaveSamples, displayWaveSamples } from "./equity-wave-day"

it("keeps a fixed Beijing 24-hour axis while intraday samples advance", () => {
  const morning = waveDayRange(Date.parse("2026-10-04T00:00:01Z"))
  const evening = waveDayRange(Date.parse("2026-10-04T15:59:59Z"))
  expect(morning).toEqual(evening)
  expect(morning.from).toBe(Date.parse("2026-10-03T16:00:00Z"))
  expect(morning.to - morning.from).toBe(86400000)
  const next = waveDayRange(Date.parse("2026-10-04T16:00:00Z"))
  expect(next.from).toBe(morning.to)
})
it("starts the new day with actual current pnl, without zero padding or yesterday's trail", () => {
  const day = waveDayRange(Date.parse("2026-10-04T16:00:01Z"))
  const points = [{ time: day.from - 1000, value: 5 }, { time: day.from, value: 7 }, { time: day.from + 1000, value: 8 }]
  expect(dayWaveSamples(points, day)).toEqual(points.slice(1))
})
it("merges dense observations to screen resolution while retaining real peaks, endpoints and gaps", () => {
  const points = Array.from({length: 10000}, (_, i) => ({ time: i * 1000, value: Math.sin(i / 200), breakBefore: i === 525 }))
  points[171].value = -10; points[7161].value = 20
  const displayed = displayWaveSamples(points, 600, {from: 0, to: 86400000})
  expect(displayed.length).toBeLessThan(points.length / 10)
  expect(displayed[0]).toEqual(points[0])
  expect(displayed.at(-1)).toEqual(points.at(-1))
  expect(Math.min(...displayed.map(p => p.value))).toBe(-10)
  expect(Math.max(...displayed.map(p => p.value))).toBe(20)
  expect(displayed.some(p => p.breakBefore)).toBe(true)
})
