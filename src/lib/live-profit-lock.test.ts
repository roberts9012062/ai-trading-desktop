import { describe, expect, it } from "vitest"
import { DEFAULT_PROFIT_LOCK, liveProfitLockDraft, liveProfitLockConfig } from "./profit-lock"
import { BUILTIN_PROFIT_LOCK_TEMPLATES, matchesProfitLockTemplate } from "./profit-lock-templates"

describe("live task lock-profit settings", () => {
  it("enables auto by default including disabled old manual configurations", () => {
    for (const config of [null, undefined, { ...BUILTIN_PROFIT_LOCK_TEMPLATES[1].config, enabled: false }]) {
      const draft = liveProfitLockDraft(config)
      expect(draft.enabled).toBe(true)
      expect(draft.mode).toBe("auto")
      expect(matchesProfitLockTemplate(draft, BUILTIN_PROFIT_LOCK_TEMPLATES[0])).toBe(true)
    }
  })
  it("refills enabled settings without mutating the task config", () => {
    const config = { ...BUILTIN_PROFIT_LOCK_TEMPLATES[1].config, unit: "usdt" as const, activation: 10, giveback: 2 }
    const draft = liveProfitLockDraft(config)
    expect(liveProfitLockConfig(draft)).toEqual(config)
    draft.activation = "20"
    expect(config.activation).toBe(10)
  })
  it("sends an explicit disabled config and still validates enabled custom parameters", () => {
    expect(liveProfitLockConfig({ ...DEFAULT_PROFIT_LOCK, mode: "manual", giveback: "bad" }).enabled).toBe(false)
    expect(() => liveProfitLockConfig({ ...DEFAULT_PROFIT_LOCK, enabled: true, mode: "manual", giveback: "5" })).toThrow()
  })
})
