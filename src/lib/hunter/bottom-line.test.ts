import { expect, it } from "vitest"
import type { Hunter } from "./api"
import type { AITradingTask } from "../ai-trading-api"
import { hunterBottomRules, bottomBreaches } from "./bottom-line"
import { buildBottomPayload } from "@/components/ai-trading/form/create-task-rules"

const group = (version = "hunter-pivot") => ({ config: { strategy_version: version, max_profit_pct: 30, max_loss_pct: 10 }, opportunities: [{ task_id: "active", finished_at: null }, { task_id: "history", finished_at: "done" }] }) as Hunter
it("loads actual native settings and supports either threshold disabled", () => {
  const h = group(), draft = hunterBottomRules(h)
  expect(draft.bottomTpPct).toBe("30")
  expect(buildBottomPayload({ ...draft, bottomTpOn: false })).toMatchObject({ max_profit_pct: null, max_loss_pct: 10 })
  expect(buildBottomPayload({ ...draft, bottomSlOn: false })).toMatchObject({ max_profit_pct: 30, max_loss_pct: null })
})
it("keeps old V4 bottom rules disabled until explicitly edited", () => {
  const h = group("hunter-v4")
  expect(hunterBottomRules(h)).toMatchObject({ bottomTpOn: false, bottomSlOn: false })
  h.config.bottom_line_revision = "edited"
  expect(hunterBottomRules(h)).toMatchObject({ bottomTpOn: true, bottomSlOn: true })
})
it("validates existing minimums and accepts large valid values", () => {
  const draft = hunterBottomRules(group())
  expect(() => buildBottomPayload({ ...draft, bottomTpPct: "9" })).toThrow()
  expect(() => buildBottomPayload({ ...draft, bottomSlPct: "4" })).toThrow()
  expect(() => buildBottomPayload({ ...draft, bottomSlPct: "Infinity" })).toThrow()
  expect(buildBottomPayload({ ...draft, bottomSlPct: "10000" }).max_loss_pct).toBe(10000)
})
it("warns only on owned unfinished positions with reliable actual margin ROI", () => {
  const task = { id: "active", symbol: "xrpusdt", position_qty: 10, position_margin: 100, position_unrealized: -10 } as AITradingTask
  const bottom = { max_profit_pct: 20, max_loss_pct: 10 }
  expect(bottomBreaches(group(), [task], bottom)).toEqual(["XRPUSDT 当前收益率 -10.00%"])
  expect(bottomBreaches(group(), [{ ...task, position_sync_status: "reconciling" }, { ...task, id: "history" }, { ...task, id: "foreign" }, { ...task, position_margin: 0 }, { ...task, position_unrealized: NaN }], bottom)).toEqual([])
  expect(bottomBreaches(group(), [{ ...task, position_unrealized: 20 }], bottom)).toHaveLength(1)
  expect(bottomBreaches(group(), [task], { ...bottom, max_loss_pct: null })).toEqual([])
})
