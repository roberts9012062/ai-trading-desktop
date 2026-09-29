import { describe, expect, it } from "vitest"
import { packNativeBars } from "./bars"

describe("native bars transport", () => {
  it("preserves timestamps, optional numeric gaps and funding flags without mutating bars", () => {
    const bars = [
      { time: "2025-01-01T00:00:00Z", close: 10, funding_estimated: false, _factor_market: "crypto_local_v2" },
      { time: "2025-01-01T00:15:00Z", close: 11, funding_rate: .001, funding_estimated: true },
    ]
    const original = structuredClone(bars)
    const packed = packNativeBars(bars, 100000, "snapshot")
    expect(packed.columns.close).toEqual(new Float64Array([10, 11]))
    expect(packed.columns.funding_estimated).toEqual(new Float64Array([0, 1]))
    expect(Number.isNaN(packed.columns.funding_rate[0])).toBe(true)
    expect(packed.columns.funding_rate[1]).toBe(.001)
    expect(packed.metadata.string_columns).toEqual({ time: bars.map(bar => bar.time),
      _factor_market: ["crypto_local_v2", null] })
    expect(packed.metadata.snapshot_id).toBe("snapshot")
    expect(bars).toEqual(original)
  })

  it("rejects invalid timestamps and excessive history before any engine request", () => {
    expect(() => packNativeBars([{ time: "bad", close: 1 }, { time: "bad", close: 2 }], 100000)).toThrow(/时间/)
    expect(() => packNativeBars(Array(100001).fill({ time: "2025-01-01", close: 1 }), 100000)).toThrow(/区间/)
    expect(() => packNativeBars([{ time: "2025-01-01", close: 1 }], 100000)).toThrow(/至少/)
  })

  it("never emits a partially-string time column that would null server-rebuilt timestamps", () => {
    const mixed = [{ time: 1735689600000, close: 10 }, { time: "2025-01-01T00:15:00Z", close: 11 }]
    const packed = packNativeBars(mixed, 100000)
    expect((packed.metadata.string_columns as Record<string, unknown>).time).toBeUndefined()
    expect(packed.columns.time_idx).toEqual(new Float64Array([1735689600000, Date.parse("2025-01-01T00:15:00Z")]))
  })
})
