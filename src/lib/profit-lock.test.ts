import { describe, expect, it } from "vitest"
import { DEFAULT_PROFIT_LOCK, buildProfitLockConfig, profitLockFromConfig } from "./profit-lock"
import { buildCloseRulesPayload, buildBottomPayload, rulesFromTask, EMPTY_RULE_FORM } from "@/components/ai-trading/form/create-task-rules"

describe("profit lock form", () => {
  it("leaves existing tasks and default rules opt-in", () => {
    expect(buildProfitLockConfig()).toBeUndefined()
    expect(buildCloseRulesPayload(EMPTY_RULE_FORM, true)).not.toHaveProperty("profit_lock")
    expect(rulesFromTask({ close_rules: {} }).profitLock?.enabled).toBe(false)
  })
  it("round-trips manual USDT and percentage configuration through edit/clone", () => {
    for (const unit of ["percent", "usdt"] as const) {
      const form = { ...DEFAULT_PROFIT_LOCK, enabled: true, mode: "manual" as const, unit, activation: "10", giveback: "1", cooldown: "5" }
      const rules = { ...EMPTY_RULE_FORM, profitLock: form }
      const payload = buildCloseRulesPayload(rules, false)
      expect(payload.profit_lock?.cooldown_signals).toBe(5)
      expect(rulesFromTask({ close_rules: payload }).profitLock).toEqual(form)
      expect(profitLockFromConfig(payload.profit_lock)).toEqual(form)
    }
  })
  it.each([["3","5"],["3","3"],["2","1"],["3","0.5"],["","1"],["NaN","1"]])("rejects unsafe threshold %s / %s before submission", (activation,giveback) => {
    const rules = { ...EMPTY_RULE_FORM, profitLock: { ...DEFAULT_PROFIT_LOCK, enabled: true, mode: "manual" as const, activation, giveback } }
    expect(() => buildCloseRulesPayload(rules, true)).toThrow()
    expect(() => buildBottomPayload(rules)).toThrow()
  })
  it("limits cooldown and accepts disabling it", () => {
    for (const cooldown of ["-1","6","1.5",""]) expect(() => buildProfitLockConfig({ ...DEFAULT_PROFIT_LOCK, enabled: true, cooldown })).toThrow()
    expect(buildProfitLockConfig({ ...DEFAULT_PROFIT_LOCK, enabled: true, cooldown: "0" })?.cooldown_signals).toBe(0)
  })
})
