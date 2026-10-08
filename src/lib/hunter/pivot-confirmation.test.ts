import { expect, it } from "vitest"
import mina from "./pivot-mina-fixture.json"
import fixtures from "./pivot-fixtures.json"
import { pivotConfirmation } from "./pivot"
import type { Bar, Direction } from "./rules"

const rows = (): Bar[] => mina.candles.map(b => [Date.parse(b.time), b.open, b.high, b.low, b.close, b.volume])
for (const side of ["long", "short"] as Direction[]) it(`rejects the actual MINA falling entry and mirrored rising short: ${side}`, () => {
  const bars = rows().map(b => side === "short" ? [b[0], 1-b[1], 1-b[3], 1-b[2], 1-b[4], b[5]] as Bar : b)
  expect(pivotConfirmation(bars, mina.now, mina, side).confirmation).toBeNull()
  expect(pivotConfirmation(bars, mina.now, mina, side).reason).toContain(side === "long" ? "做多" : "做空")
})
it("requires a closed reversal bar and never accepts a forming-only bounce", () => {
  const f = fixtures[0]
  expect(pivotConfirmation(f.rows as Bar[], f.now, f.expected!, "long").reason).toContain("尚无已收盘")
})
it("accepts a closed bullish reversal only while the current price maintains it", () => {
  const bars = rows()
  bars.at(-2)![4] = .08945
  bars.at(-1)![1] = .08946; bars.at(-1)![2] = .08955; bars.at(-1)![3] = .0894; bars.at(-1)![4] = .0895
  expect(pivotConfirmation(bars, mina.now, mina, "long").confirmation?.close).toBe(.08945)
  bars.at(-1)![4] = .0894
  expect(pivotConfirmation(bars, mina.now, mina, "long").reason).toContain("不利一侧")
})
it("rejects a bullish body below the previous close and a doji", () => {
  const bars = rows(); bars.at(-2)![1] = .088
  expect(pivotConfirmation(bars, mina.now, mina, "long").confirmation).toBeNull()
  bars.at(-2)![1] = bars.at(-2)![4]
  expect(pivotConfirmation(bars, mina.now, mina, "long").confirmation).toBeNull()
})
