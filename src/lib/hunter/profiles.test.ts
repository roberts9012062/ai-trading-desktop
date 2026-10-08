import { describe, expect, it } from "vitest"
import { DEFAULT_HUNTER_VERSION, HUNTER_STRATEGIES } from "./profiles"

describe("consolidated hunter choices", () => {
  it("offers the final trend version and independent rebound/pivot strategies", () => {
    expect(HUNTER_STRATEGIES.map(s => s.version)).toEqual(["hunter-v4", "hunter-rebound", "hunter-pivot"])
    expect(DEFAULT_HUNTER_VERSION).toBe("hunter-v4")
  })
})
