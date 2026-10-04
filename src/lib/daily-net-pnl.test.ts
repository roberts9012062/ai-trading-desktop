import { expect, it } from "vitest"
import { dailyNetPnl, paperTodayNetPnl } from "./daily-net-pnl"
import type { DailyPnlRow } from "./live-api"
import type { PaperOrderItem } from "./paper-api"
it("uses authoritative net once, and supports old gross responses", () => {
  const row = { pnl: 10, net: 10, fee: 4, funding: -1 } as DailyPnlRow
  expect(dailyNetPnl(row)).toBe(5)
  expect(dailyNetPnl({ ...row, net_after_costs: 5 })).toBe(5)
  expect(dailyNetPnl({ ...row, net_after_costs: 0 })).toBe(0)
  expect(dailyNetPnl({ ...row, fee_cost: -2 })).toBe(11)
})
it("deducts opening and closing fees at Beijing day boundaries, excluding pending orders", () => {
  const now = Date.parse("2026-10-04T12:00:00Z")
  const order = { status: "filled", filled_qty: 1, offset: "close", realized_pnl: 10, fee: 2, filled_at: "2026-10-04T01:00:00Z" } as PaperOrderItem
  const rows = [order, { ...order, offset: "open", realized_pnl: 0, fee: 3, filled_at: "2026-10-03T16:00:00Z" }, { ...order, filled_at: "2026-10-03T15:59:59Z" }, { ...order, status: "pending", filled_qty: 0, fee: 9 }]
  expect(paperTodayNetPnl(rows, now)).toMatchObject({ sum: 5, fee: 5, count: 1 })
})
