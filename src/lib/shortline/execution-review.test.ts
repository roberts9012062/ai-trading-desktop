import { expect, it } from "vitest"
import { boundedReviewDays } from "./execution-review"
import { serverShortlinePayload } from "./server-api"
import { buildShortlinePayload } from "./mount"

it("bounds short cadence review requests before uploading", () => {
  expect(boundedReviewDays(30, 3)).toBe(5)
  expect(boundedReviewDays(14, 15)).toBe(14)
  expect(() => boundedReviewDays(NaN, 15)).toThrow()
})
it("converts desktop lineage at the API boundary without mutating local formulas", () => {
  const p = buildShortlinePayload({symbol:"ETHUSDT", timeframe:"1m", cadence:15,
    champions:[{id:1,tokens:[45,111]}]}, "a".repeat(64))
  expect(serverShortlinePayload(p).champions[0]!.tokens).toEqual([66,175])
  expect(p.champions[0]!.tokens).toEqual([45,111])
  expect(serverShortlinePayload(serverShortlinePayload(p))).toEqual(serverShortlinePayload(p))
})
it("adds an identity marker for a bare v3 feature", () => {
  const p = buildShortlinePayload({symbol:"ETHUSDT", timeframe:"1m", cadence:15,
    champions:[{id:1,tokens:[36]}]}, "a".repeat(64))
  expect(serverShortlinePayload(p).champions[0]!.tokens).toEqual([57,135,135])
})
