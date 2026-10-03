import { describe, expect, it } from "vitest"
import { closedBars, sizePosition, trend, findSignal, entrySignal, BALANCED_VERSION, rankFraction, type Bar, type Direction } from "./rules"

describe("hunter risk and closed-bar rules", () => {
  it.each([1, 5, 50])("uses %sx leverage for margin without increasing quantity or risk", leverage => {
    const p = sizePosition(10000, "medium", 100, 99.5, .0005, "long", leverage)
    const baseline = sizePosition(10000, "medium", 100, 99.5, .0005)
    expect(p.quantity).toBe(baseline.quantity)
    expect(p.risk_budget).toBe(baseline.risk_budget)
    expect(p.margin).toBeCloseTo(p.notional / leverage)
    expect(p.leverage).toBe(leverage)
  })
  it.each([0, 51, 1.5, NaN, Infinity])("rejects invalid leverage %s", leverage => {
    expect(() => sizePosition(10000, "medium", 100, 99.5, .0005, "long", leverage)).toThrow()
  })
  it.each(["long", "short"] as const)("rejects unsafe 50x %s stop distances", direction => {
    expect(() => sizePosition(10000, "medium", 100, direction === "long" ? 97 : 103, .002, direction, 50)).toThrow(/杠杆/)
  })
  it("includes costs in the account loss budget", () => {
    const p = sizePosition(10000, "medium", 100, 97, .002)
    expect(p.quantity * 3.2).toBeLessThanOrEqual(30.00000001)
  })
  it("rejects expensive trades and invalid stops", () => {
    expect(() => sizePosition(10000, "short", 100, 101, .001)).toThrow()
    expect(() => sizePosition(10000, "short", 100, 99.8, .001)).toThrow()
  })
  it("excludes the current unfinished bar", () => {
    expect(closedBars([[0, 100, 101, 99, 100, 10], [300000, 100, 102, 99, 101, 10]], 300, 400)).toHaveLength(1)
  })
  it("does not treat insufficient history as a trend", () => {
    expect(trend([[0, 1, 1, 1, 1, 1]], "short", "long")).toBe(false)
  })
})

it.each(["long", "short"] as const)("versions balanced breakout volume and TTL for %s", direction => {
  const [setup, execution] = signalFixture(direction)
  setup.at(-1)![5] = 130
  expect(entrySignal(setup, execution, "short", direction, 19600)).toBeNull()
  const entry = entrySignal(setup, execution, "short", direction, 19600, BALANCED_VERSION)
  expect(entry?.entry_kind).toBe("breakout")
  expect(entry?.expires_at).toBe(19680)
  expect(entrySignal(setup, execution, "short", direction, 19681, BALANCED_VERSION)).toBeNull()
  expect(rankFraction()).toBe(.2); expect(rankFraction(BALANCED_VERSION)).toBe(.3)
})

it.each(["long", "short"] as const)("matches server EMA20 pullback golden for %s without forming bars", direction => {
  let setup: Bar[] = Array.from({ length: 26 }, (_, i) => [i*900000, 100, 100.5, 99.5, 100, 100])
  let execution: Bar[] = Array.from({ length: 80 }, (_, i) => [i*300000, 100+i*.1-.02, 100+i*.1+.12, 100+i*.1-.12, 100+i*.1, 100])
  execution[78] = [23400000, 107.8, 107.9, 106.7, 107, 100]
  execution[79] = [23700000, 107, 108.5, 106.95, 108.3, 100]
  if (direction === "short") { const mirror = (rows: Bar[]): Bar[] => rows.map(b => [b[0], 220-b[1], 220-b[3], 220-b[2], 220-b[4], b[5]]); setup = mirror(setup); execution = mirror(execution) }
  const entry = entrySignal(setup, execution, "short", direction, 24010, BALANCED_VERSION)
  expect(entry?.entry_kind).toBe("pullback")
  expect(entry?.entry).toBeCloseTo(direction === "long" ? 108.3 : 111.7)
  expect(entry?.signal_at).toBe(24000); expect(entry?.expires_at).toBe(24180)
  expect(entrySignal(setup, execution, "short", direction, 23999, BALANCED_VERSION)).toBeNull()
  expect(entrySignal(setup, execution, "short", direction, 24181, BALANCED_VERSION)).toBeNull()
  expect(entrySignal(setup, execution, "short", direction, 24010)).toBeNull()
})

function signalFixture(direction: Direction): [Bar[], Bar[]] {
  const setup: Bar[] = Array.from({ length: 20 }, (_, i) => [i*900000, 100.5, 101, 100, 100.5, 100])
  setup.push([18000000, 100.5, 103, 100, 102, 200])
  const execution: Bar[] = [[18900000, 102, 102.2, 100.9, 101.2, 100], [19200000, 101.2, 103, 101, 102.5, 100]]
  const mirror = (rows: Bar[]): Bar[] => rows.map(b => [b[0], 200-b[1], 200-b[3], 200-b[2], 200-b[4], b[5]])
  return direction === "long" ? [setup, execution] : [mirror(setup), mirror(execution)]
}
it.each([
  ["long", 102.5, 100.61428571428571],
  ["short", 97.5, 99.38571428571429],
] as const)("matches the server golden signal for %s and rejects future/expired confirmation", (direction, entry, stop) => {
  const [setup, execution] = signalFixture(direction)
  const signal = findSignal(setup, execution, "short", direction, 19510)
  expect(signal?.entry).toBe(entry)
  expect(signal?.stop).toBeCloseTo(stop, 10)
  expect(signal?.signal_at).toBe(19500)
  expect(findSignal(setup, execution, "short", direction, 19499)).toBeNull()
  expect(findSignal(setup, execution, "short", direction, 19561)).toBeNull()
  expect(findSignal(setup, execution.slice(0, 1), "short", direction, 19510)).toBeNull()
})
