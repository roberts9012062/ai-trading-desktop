import { describe, expect, it } from "vitest"
import { DEFAULT_HUNTER_VERSION, HUNTER_STRATEGIES } from "./profiles"

describe("consolidated hunter choices", () => {
  it("only offers the final trend version and independent rebound strategy", () => {
    expect(HUNTER_STRATEGIES.map(s => s.version)).toEqual(["hunter-v4", "hunter-rebound"])
    expect(DEFAULT_HUNTER_VERSION).toBe("hunter-v4")
  })
})
