import { describe, expect, it } from "vitest"
import fixture from "./pivot-fixtures.json"
import { pivotEntry, pivotConfirmation } from "./pivot"
import type { Bar, Direction } from "./rules"

describe("shared quant/server pivot entry fixtures", () => {
  for (const row of fixture) it(row.name, () => {
    const signal = pivotEntry(row.rows as Bar[], row.now, row.params, row.direction as Direction)
    if (row.expected) expect(signal).toMatchObject(row.expected)
    else expect(signal).toBeNull()
  })
  it("rejects stale, discontinuous and malformed market snapshots", () => {
    const row = fixture[0], bars = row.rows as Bar[]
    expect(pivotEntry(bars, row.now+3600, row.params)).toBeNull()
    expect(pivotEntry(bars.slice(1).filter((_, i) => i !== 4), row.now, row.params)).toBeNull()
    expect(pivotEntry([...bars.slice(0, -1), [bars.at(-1)![0], NaN, 1, 1, 1, 1]], row.now, row.params)).toBeNull()
  })
})

it("maps either source pivot to the reversed actual side and confirms the source candle", () => {
  for (const row of fixture.filter(f => f.expected && f.params.min_right_live < f.params.right)) {
    const source = row.direction as Direction, actual = source === "long" ? "short" : "long"
    const params = { ...row.params, reverse_entry: true }
    const rows = row.rows.map((b, i) => i >= row.rows.length-2 ? [b[0], b[4]+(source === "long" ? -2 : 2), ...b.slice(2)] as Bar : b as Bar)
    const signal = pivotEntry(rows, row.now, params, actual)
    expect(signal?.point.side).toBe(source)
    expect(pivotEntry(rows, row.now, params, source)).toBeNull()
    if (signal && rows.length-1-signal.point.index >= 2) {
      expect(pivotConfirmation(rows, row.now, signal, actual).confirmation?.direction).toBe(source)
    }
  }
})
