import {expect, it} from "vitest"
import {completeFundingMonthEnd, evolutionFundingIssue, evolutionHistoryGap, evolutionSamplePlan} from "./factor-evolution-samples"
import type {KlineBar} from "@/types"
const settings = {train_ratio:.7, test_recent_bars:0, walk_forward_folds:3}
const bar = (time: string) => ({time, open:1, high:1, low:1, close:1, volume:1}) as KlineBar
it("rejects 60 fixed bars even with two years of ADA candles", () => {
  const plan = evolutionSamplePlan(70176,"15m",{...settings,test_recent_bars:60})
  expect(plan.minValidation).toBe(673)
  expect(plan.fixedIssue).toMatch(/60.*673.*0.*按比例/)
})
it("accepts proportional two-year history without reducing validation gates", () => {
  expect(evolutionSamplePlan(70176,"15m",settings)).toMatchObject({issue:null,train:39298,validation:16842,holdout:14036,warmup:320})
  expect(evolutionSamplePlan(1000,"60m",settings).issue).toMatch(/实际 1000.*训练.*验证.*封存/)
})
it("checks calendar span as well as fold count", () => {
  expect(evolutionSamplePlan(70176,"15m",{...settings,test_recent_bars:672}).fixedIssue).not.toBeNull()
  expect(evolutionSamplePlan(70176,"15m",{...settings,test_recent_bars:673}).fixedIssue).toBeNull()
  expect(evolutionSamplePlan(70176,"1m",settings).minValidation).toBe(10081)
})
it("reports the real missing interval instead of synthesizing exchange candles", () => {
  const bars=[bar("2026-07-29 15:00:00"),bar("2026-07-29 15:30:00")]
  expect(evolutionHistoryGap(bars,"15m")).toMatchObject({suggestedStart:"2026-07-30"})
  expect(evolutionHistoryGap([bars[0],bar("2026-07-29 15:15:00")],"15m")).toBeNull()
})
it("explains unpublished funding without silently trimming dates", () => {
  const bars=[bar("2026-09-30 08:00:00"),bar("2026-10-10 08:00:00")]
  expect(evolutionFundingIssue(bars,[{t:Date.UTC(2026,8,30),r:.0001}])).toContain("月归档")
  expect(completeFundingMonthEnd(Date.UTC(2026,9,12))).toBe("2026-09-30")
  expect(completeFundingMonthEnd(Date.UTC(2026,0,2))).toBe("2025-12-31")
})
it("requires actual uninterrupted funding events", () => {
  const bars=[bar("2026-09-01 08:00:00"),bar("2026-09-02 08:00:00")]
  const events=[0,8,16,24].map(h=>({t:Date.UTC(2026,8,1,h),r:.0001}))
  expect(evolutionFundingIssue(bars,events)).toBeNull()
  expect(evolutionFundingIssue(bars,[events[0],events[3]])).toContain("结算缺口")
})
