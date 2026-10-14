import {describe, expect, it} from "vitest"
import {EMPTY_FAVORITE_FILTERS, favoriteAnnualPercent, matchesFavoriteFilters} from "./favorite-filters"
describe("favorite period and annual filters", () => {
  it("combines aliased periods with inclusive percent bounds", () => {
    const filter = {timeframe:"240m", minAnnual:"-10", maxAnnual:"50"}
    expect(matchesFavoriteFilters("4h", 50, filter)).toBe(true)
    expect(matchesFavoriteFilters("4h", -10, filter)).toBe(true)
    expect(matchesFavoriteFilters("15m", 20, filter)).toBe(false)
    expect(matchesFavoriteFilters("4h", 51, filter)).toBe(false)
  })
  it("preserves missing data when unrestricted and excludes it for annual ranges", () => {
    expect(matchesFavoriteFilters("5m", null, EMPTY_FAVORITE_FILTERS)).toBe(true)
    expect(matchesFavoriteFilters("5m", null, {...EMPTY_FAVORITE_FILTERS,minAnnual:"0"})).toBe(false)
    expect(matchesFavoriteFilters("5m", NaN, {...EMPTY_FAVORITE_FILTERS,maxAnnual:"10"})).toBe(false)
    expect(favoriteAnnualPercent({ann_ret:-.2})).toBe(-20)
    expect(favoriteAnnualPercent({ann_ret:null})).toBeNull()
  })
  it("never silently accepts invalid or reversed ranges", () => {
    expect(matchesFavoriteFilters("5m", 20, {...EMPTY_FAVORITE_FILTERS,minAnnual:"abc"})).toBe(false)
    expect(matchesFavoriteFilters("5m", 20, {...EMPTY_FAVORITE_FILTERS,minAnnual:"50",maxAnnual:"0"})).toBe(false)
  })
})
