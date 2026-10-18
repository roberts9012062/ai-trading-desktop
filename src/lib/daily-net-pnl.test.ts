import { expect, it } from "vitest"
import { dailyNetPnl, paperTodayNetPnl, netDailyPnlView } from "./daily-net-pnl"
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
it('keeps calendar, curve and summary on the same net value without deducting fees twice',()=>{
  const row={pnl:10,fee:1,net:10,net_after_costs:9,cumulative:10} as DailyPnlRow
  const result=netDailyPnlView({days:[row,{...row,pnl:-4,net_after_costs:-5}],summary:{net:6,total_profit:10,total_loss:-4,profit_ratio:2.5,trade_days:2,total_trades:2}})
  expect(result.days.map(r=>r.net)).toEqual([9,-5])
  expect(result.days.map(r=>r.cumulative)).toEqual([9,4])
  expect(result.summary).toMatchObject({net:4,total_profit:9,total_loss:-5,profit_ratio:1.8})
  expect(row.net).toBe(10)
})
