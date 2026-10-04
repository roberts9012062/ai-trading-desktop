import { describe, expect, it } from "vitest"
import { entrySignal, rankFraction, cycleRules, type Bar, type Cycle } from "./rules"
import { targetPrice, netRR, directionQuality } from "./swing"

describe("v4 additive swing rules", () => {
  it.each(["long", "short"] as const)("deducts costs on both sides: %s", direction => {
    const sign = direction === "long" ? 1 : -1, stop = 100-sign*2
    const target = targetPrice(100, stop, .001, direction)
    expect(netRR(100, stop, target, .001, direction)).toBeCloseTo(3, 10)
    expect(netRR(100+sign*.2, stop, target, .001, direction)).toBeLessThan(3)
    const risk = 2+Math.max(100, stop)*.001
    expect(sign*(target-100)-Math.max(100, target)*.001).toBeGreaterThanOrEqual(3*risk-1e-9)
  })
  it.each(["medium", "long"] as Cycle[])("adds continuation for %s without changing v3", cycle => {
    const sec = cycle === "medium" ? 3600 : 86400
    const rows: Bar[] = Array.from({ length: 80 }, (_, i) => [i*sec*1000, 100+i*.02, 100+i*.02+.3, 100+i*.02-.3, 100+i*.02, 100])
    rows[79] = [79*sec*1000, 101.4, 102.3, 101.35, 102.2, 130]
    const result = entrySignal([], rows, cycle, "long", 80*sec+2, "hunter-v4")
    expect(result?.entry_kind).toBe("continuation")
    expect(entrySignal([], rows, cycle, "long", 80*sec-1, "hunter-v4")).toBeNull()
    expect(entrySignal([], rows, cycle, "long", 80*sec+2, "hunter-v3")).toBeNull()
  })
  it("preserves legacy settings", () => {
    expect(rankFraction("hunter-v4")).toBe(.5)
    expect(rankFraction("hunter-v3")).toBe(.5)
    expect(rankFraction("hunter-v1")).toBe(.2)
    expect(cycleRules("short", "hunter-v4").ttl).toBe(240)
  })
  it("requires direction efficiency and checks four-hour macro on hourly data", () => {
    const rows: Bar[] = Array.from({ length: 450 }, (_, i) => [i*3600000, 100+i*.1, 100+i*.1+.15, 100+i*.1-.15, 100+i*.1, 100])
    expect(directionQuality(rows, "short", "long")).toBe(true)
    expect(directionQuality(rows, "short", "short")).toBe(false)
    const choppy: Bar[] = Array.from({ length: 450 }, (_, i) => [i*3600000, 100+i*.005, 100.4+i*.005, 99.6+i*.005, 100+i*.005+(i%2 ? .15 : -.15), 100])
    expect(directionQuality(choppy, "short", "long")).toBe(false)
  })
})
