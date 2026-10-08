import { describe, expect, it } from "vitest"
import fixture from "./pivot-fixtures.json"
import { pivotEntry } from "./pivot"
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
