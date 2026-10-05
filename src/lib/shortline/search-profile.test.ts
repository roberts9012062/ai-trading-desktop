import { describe, expect, it } from "vitest"
import { enhancedShortlineSearch, filterSearchFeatures } from "./search-profile"
import { checkMountable } from "./mount"

describe("enhanced shortline search", () => {
  it("preserves default pools and filters only explicit restricted searches", () => {
    expect(filterSearchFeatures([1, 55, 62], undefined)).toEqual([1, 55, 62])
    expect(filterSearchFeatures([1, 55, 62], [1, 2])).toEqual([1])
    expect(() => filterSearchFeatures([55], [1, 2])).toThrow()
  })
  it("seeds multiple server-computable families and enables combinations", () => {
    const profile = enhancedShortlineSearch(123)
    expect(profile.combo_super).toBe(true)
    expect(profile.seed_tokens.length).toBeGreaterThanOrEqual(8)
    expect(profile.seed).toBe(123)
    expect(checkMountable(profile.seed_tokens).ok).toBe(true)
    expect(profile.search_feature_ids).not.toContain(55)
    expect(profile.search_feature_ids).not.toContain(62)
  })
})
