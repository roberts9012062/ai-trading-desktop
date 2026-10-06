import { describe, expect, it } from "vitest"
import { EMPTY_RULE_FORM, buildBottomPayload, rulesFromTask } from "@/components/ai-trading/form/create-task-rules"

describe("losing round protection form", () => {
  it("defaults on for new tasks and existing task edits", () => {
    expect(buildBottomPayload(EMPTY_RULE_FORM)).toMatchObject({ loss_cooldown_enabled: true, loss_cooldown_limit: 2 })
    expect(rulesFromTask({})).toMatchObject({ lossCooldownOn: true, lossCooldownLimit: "2" })
  })
  it("retains disabled/custom values when editing or cloning", () => {
    const form = rulesFromTask({ loss_cooldown_enabled: false, loss_cooldown_limit: 10 })
    expect(buildBottomPayload(form)).toMatchObject({ loss_cooldown_enabled: false, loss_cooldown_limit: 10 })
  })
  it.each(["0", "11", "1.5", "", "NaN", "Infinity"])("rejects invalid limit %s", (value) => {
    expect(() => buildBottomPayload({ ...EMPTY_RULE_FORM, lossCooldownLimit: value })).toThrow("1–10")
  })
  it.each(["1", "2", "10"])("allows limit %s", (value) => {
    expect(buildBottomPayload({ ...EMPTY_RULE_FORM, lossCooldownLimit: value }).loss_cooldown_limit).toBe(Number(value))
  })
})
