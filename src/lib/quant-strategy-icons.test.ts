import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { QUANT_KIND_OPTIONS } from "./quant-strategy"
import { AI_ICONS, iconSrc, isValidIconSlug } from "./ai-icons-manifest"
import { resolveTaskIconSrc, strategyIconSrc } from "./quant-strategy-icons"

describe("distinct automatic strategy avatars", () => {
  it("covers every selectable and paused strategy with a distinct shipped vector", () => {
    const sources = QUANT_KIND_OPTIONS.map(option => strategyIconSrc(option.value))
    expect(sources).toHaveLength(12)
    expect(new Set(sources).size).toBe(sources.length)
    const contents = sources.map(src => readFileSync(`public${src}`, "utf8"))
    expect(new Set(contents).size).toBe(contents.length)
    for (const content of contents) expect(content).toContain('<svg xmlns="http://www.w3.org/2000/svg"')
  })
  it("replaces generic server defaults and handles all newer strategy types", () => {
    for (const { value } of QUANT_KIND_OPTIONS) {
      expect(resolveTaskIconSrc(null, value)).toBe(strategyIconSrc(value))
      expect(resolveTaskIconSrc("quant", value)).toBe(strategyIconSrc(value))
    }
    expect(resolveTaskIconSrc("factor", "factor")).toBe("/strategy-icons/factor.svg")
  })
  it("keeps user chosen provider and strategy avatars", () => {
    expect(resolveTaskIconSrc("openai", "ma_cross")).toBe("/ai-icons/openai.png")
    expect(resolveTaskIconSrc("factor", "ma_cross")).toBe("/ai-icons/factor.png")
    expect(resolveTaskIconSrc("strategy-kdj-cross", "ma_cross")).toBe("/strategy-icons/kdj_cross.svg")
  })
  it("keeps AI provider matching and rejects invalid strategy/path values", () => {
    expect(resolveTaskIconSrc(null, "ai", "/ai-icons/claude.png")).toBe("/ai-icons/claude.png")
    expect(resolveTaskIconSrc(null, "decision", "/ai-icons/default.svg")).toBeNull()
    expect(strategyIconSrc("../../secret")).toBeNull()
    expect(strategyIconSrc("constructor")).toBeNull()
    expect(strategyIconSrc("MA_CROSS")).toBe("/strategy-icons/ma_cross.svg")
  })
  it("makes each strategy available in the task icon picker without changing old provider paths", () => {
    for (const { value } of QUANT_KIND_OPTIONS) {
      const entry = AI_ICONS.find(entry => entry.src === strategyIconSrc(value))!
      expect(isValidIconSlug(entry.slug)).toBe(true)
      expect(iconSrc(entry.slug)).toBe(strategyIconSrc(value))
    }
    expect(iconSrc("quant")).toBe("/ai-icons/quant.png")
  })
})
