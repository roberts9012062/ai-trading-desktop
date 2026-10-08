import { expect, it } from "vitest"
import { paramsToQuantState, buildStrategyParams, DEFAULT_QUANT_PARAMS, validateQuantParams } from "./quant-strategy"

it("round trips chart-compatible pivot parameters including alternation", () => {
  const p = { left: 6, right: 6, min_right_live: 2, min_amplitude_pct: 1.5, min_atr_mult: 1.5, atr_period: 14, alternate: false }
  expect(buildStrategyParams(paramsToQuantState("swing_pivot", p))).toEqual(p)
})

it("legacy task without P remains formal-only when edited", () => {
  expect(paramsToQuantState("swing_pivot", { left: 6, right: 6 }).swingMinRightLive).toBe(6)
  expect(DEFAULT_QUANT_PARAMS.swingMinRightLive).toBe(1)
})

it("rejects out-of-range pivot parameters on submission instead of silent server clamping", () => {
  expect(validateQuantParams({ ...DEFAULT_QUANT_PARAMS, quantKind: "swing_pivot", swingLeft: 21 })).toBeTruthy()
  expect(validateQuantParams({ ...DEFAULT_QUANT_PARAMS, quantKind: "swing_pivot", swingMinAtrMult: 11 })).toBeTruthy()
})

it("round trips explicit reverse entry while legacy tasks remain normal", () => {
  expect(paramsToQuantState("swing_pivot", {}).swingReverseEntry).toBe(false)
  const p = { ...buildStrategyParams({ ...DEFAULT_QUANT_PARAMS, quantKind: "swing_pivot" }), reverse_entry: true }
  expect(paramsToQuantState("swing_pivot", p).swingReverseEntry).toBe(true)
  expect(buildStrategyParams(paramsToQuantState("swing_pivot", p))).toEqual(p)
})
