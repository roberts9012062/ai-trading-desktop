import { expect, it } from "vitest"
import { buildSearchConfig, toLocalSearchStep } from "../local-factor"

it("retains automatic seed origin and the adaptation notice through the search UI protocol", () => {
  const config = buildSearchConfig({ symbol: "dotusdt", timeframe: "1d", population: 20,
    generations: 1, top_n: 2, seed: 42, seed_tokens: [[10]], seed_origin: "champion_library" })
  expect(config.seed_origin).toBe("champion_library")
  expect(config.seed_tokens).toEqual([[10]])
  const step = toLocalSearchStep({ generation: 1, totalGenerations: 1, bestComposite: 0,
    elapsedMs: 100, seedWarning: "自动种子适配：使用 3/4 条" }, "cpu")
  expect(step.seedWarning).toContain("3/4")
})
