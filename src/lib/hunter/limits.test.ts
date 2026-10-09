import { expect, it } from "vitest"
import { hunterPositionLimit, validateHunterPositions } from "./limits"

it("caps all ordinary-user strategies at three and preserves administrator limits", () => {
  for (const strategy of ["hunter-v4", "hunter-rebound", "hunter-pivot"]) {
    expect(hunterPositionLimit(false, strategy)).toBe(3)
  }
  expect(hunterPositionLimit(true, "hunter-pivot")).toBe(10)
  expect(hunterPositionLimit(true, "hunter-v4")).toBe(4)
  expect(hunterPositionLimit(true, "hunter-rebound")).toBe(4)
})

it("rejects invalid or excessive reservations before submission", () => {
  for (const value of [0, -1, 3.5, 4, NaN, Infinity]) expect(validateHunterPositions(value, 3)).toBeTruthy()
  for (const value of [1, 2, 3]) expect(validateHunterPositions(value, 3)).toBeNull()
  expect(validateHunterPositions(10, 10)).toBeNull()
})
