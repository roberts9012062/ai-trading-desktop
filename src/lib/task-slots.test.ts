import { expect, it } from "vitest"
import { slotSummary, slotSourceLabel } from "./task-slots"

it("explains additive quotas and independent source labels", () => {
  expect(slotSummary({base:1,gift:1,vip:2,total:4,used:3,available:1,close_only:0,unlimited:false})).toBe("任务槽：已用 3 / 4（基础 1＋永久赠送 1＋VIP 2）")
  expect(slotSourceLabel("gift")).toBe("永久赠送槽")
  expect(slotSourceLabel("vip")).toBe("VIP 任务槽")
})
