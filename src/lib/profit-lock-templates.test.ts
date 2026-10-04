import { describe, expect, it } from "vitest"
import { BUILTIN_PROFIT_LOCK_TEMPLATES, applyProfitLockTemplate, matchesProfitLockTemplate, profitLockTemplateBody } from "./profit-lock-templates"
import { DEFAULT_PROFIT_LOCK, buildProfitLockConfig } from "./profit-lock"
import { buildCloseRulesPayload, EMPTY_RULE_FORM } from "@/components/ai-trading/form/create-task-rules"

describe("profit lock template snapshots", () => {
  it("keeps task switches independent and copies the selected parameters", () => {
    const template = structuredClone(BUILTIN_PROFIT_LOCK_TEMPLATES[1])
    const draft = applyProfitLockTemplate(template, false)
    expect(draft.enabled).toBe(false)
    expect(buildProfitLockConfig(draft)).toBeUndefined()
    template.config.activation = 20
    expect(draft.activation).toBe("3")
  })
  it("edits and deletes templates without changing already-created tasks or another draft", () => {
    const templates = structuredClone(BUILTIN_PROFIT_LOCK_TEMPLATES)
    const first = applyProfitLockTemplate(templates[1], true)
    const second = applyProfitLockTemplate(templates[1], true)
    const task = buildCloseRulesPayload({ ...EMPTY_RULE_FORM, profitLock: first }, false)
    first.activation = "10"
    templates[1].config.giveback = 2
    templates.splice(1, 1)
    expect(task.profit_lock?.activation).toBe(3)
    expect(task.profit_lock?.giveback).toBe(1)
    expect(second.activation).toBe("3")
  })
  it("validates named templates using the same rules as task creation", () => {
    const form = { ...DEFAULT_PROFIT_LOCK, mode: "manual" as const }
    expect(profitLockTemplateBody("  短线  ", form).name).toBe("短线")
    expect(profitLockTemplateBody("短线", form).config.enabled).toBe(true)
    expect(() => profitLockTemplateBody(" ", form)).toThrow()
    expect(() => profitLockTemplateBody("a".repeat(81), form)).toThrow()
    expect(() => profitLockTemplateBody("错误", { ...form, giveback: "5" })).toThrow()
    expect(() => profitLockTemplateBody("错误", { ...form, cooldown: "6" })).toThrow()
  })
  it("detects adjusted parameters while normalizing auto-only ignored fields", () => {
    const template = BUILTIN_PROFIT_LOCK_TEMPLATES[0]
    const draft = applyProfitLockTemplate(template, true)
    expect(matchesProfitLockTemplate(draft, template)).toBe(true)
    expect(matchesProfitLockTemplate({ ...draft, unit: "usdt", activation: "10" }, template)).toBe(true)
    expect(matchesProfitLockTemplate({ ...draft, cooldown: "3" }, template)).toBe(false)
  })
})
