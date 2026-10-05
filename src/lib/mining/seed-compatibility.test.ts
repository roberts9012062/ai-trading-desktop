import { describe, expect, it } from "vitest"
import { championSeedsFor } from "./champion-seeds"
import { automaticLibrarySeeds, compatibleTrainingSeeds } from "./seed-compatibility"
import type { MiningConfig } from "./types"

const seeds = championSeedsFor("dotusdt", "1d").seeds.map(seed => seed.tokens)
const config: MiningConfig = { symbol: "dotusdt", timeframe: "1d", population: 20,
  generations: 2, max_depth: 3, train_ratio: .7, walk_forward_folds: 3,
  crypto_profile: true, seed_origin: "champion_library", seed_tokens: seeds }
const names = Array.from({ length: 62 }, (_, i) => i === 54 ? "TAKER_IMBALANCE" : `feature${i}`)
const available = Array.from({ length: 62 }, (_, i) => i)

describe("training seed compatibility", () => {
  it("admits three DOT daily library seeds without promoting absent OKX taker flow", () => {
    const active = available.filter(i => i !== 54)
    const original = structuredClone(config)
    const selection = compatibleTrainingSeeds(config, active, names)
    expect(selection.seeds).toHaveLength(3)
    expect(selection.seeds.flat()).not.toContain(54)
    expect(selection.warning).toContain("3/4")
    expect(selection.warning).toContain("TAKER_IMBALANCE")
    expect(config).toEqual(original)
    expect(active).not.toContain(54)
  })

  it("retains all compatible seeds and does not emit a warning", () => {
    expect(compatibleTrainingSeeds(config, available, names)).toMatchObject({ seeds, warning: undefined, rejected: [] })
  })

  it("can skip the entire automatic seed set while leaving random evolution available", () => {
    expect(compatibleTrainingSeeds(config, [0], names)).toMatchObject({ seeds: [], warning: expect.stringContaining("0/4") })
  })

  it("recognizes old saved automatic requests only by their complete seed selection", () => {
    expect(automaticLibrarySeeds({ ...config, seed_origin: undefined })).toBe(true)
    expect(automaticLibrarySeeds({ ...config, seed_origin: undefined, seed_tokens: [seeds[1]] })).toBe(false)
    expect(automaticLibrarySeeds({ ...config, seed_origin: "custom" })).toBe(false)
  })

  it("does not treat an arbitrary formula as automatic even with the library origin flag", () => {
    expect(() => compatibleTrainingSeeds({ ...config, seed_tokens: [[54, 71]] }, [0], names)).toThrow("TAKER_IMBALANCE")
  })

  it("rejects explicit custom seeds with the missing feature name", () => {
    expect(() => compatibleTrainingSeeds({ ...config, seed_origin: "custom" }, available.filter(i => i !== 54), names))
      .toThrow("主动买卖量不平衡")
  })

  it("respects a restricted search pool and does not use validation or holdout availability", () => {
    const selected = available.filter(i => i !== 10)
    expect(compatibleTrainingSeeds(config, selected, names).seeds).toEqual([])
  })
})
