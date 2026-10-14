import {expect, it} from "vitest"
import {ALL_MINING_FEATURE_IDS, ALL_SHORTLINE_FEATURE_IDS, MINING_FEATURES, restrictSeeds} from "./feature-selection"
import {filterSearchFeatures} from "@/lib/shortline/search-profile"
it("keeps canonical desktop rows and shortline token mapping distinct from operators", () => {
  expect(ALL_MINING_FEATURE_IDS).toHaveLength(64)
  expect(ALL_SHORTLINE_FEATURE_IDS).toHaveLength(72)
  expect(MINING_FEATURES[62]?.name).toBe("MACD_HIST")
  expect(MINING_FEATURES[64]?.name).toBe("SL_OF_IMB")
  expect(MINING_FEATURES.every(f => f.description && f.category)).toBe(true)
  expect(restrictSeeds([[0,71],[1,71],[115,71],[116,71],[0,1,64]], [0,64])).toEqual([[0,71],[115,71]])
})
it("enforces selected feature pools and fails with no usable training data", () => {
  expect(filterSearchFeatures([0,1,62,63], [1,63])).toEqual([1,63])
  expect(() => filterSearchFeatures([0,1], [52])).toThrow()
  expect(() => filterSearchFeatures([0], [])).toThrow()
})
