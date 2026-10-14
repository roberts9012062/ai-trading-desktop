import {expect, it} from "vitest"
import {buildStrategyParams, paramsToQuantState, validateQuantParams, DEFAULT_QUANT_PARAMS} from "./quant-strategy"
it("round trips collaboration formula names without converting to weighted averaging", () => {
  const raw = {factor_tokens:[[0,135],[1,135]], factor_names:["趋势","反转"], winner_metric:"open_return"}
  const state = paramsToQuantState("multi_factor", raw)
  expect(buildStrategyParams(state)).toEqual(raw)
  expect(validateQuantParams(state)).toBeNull()
})
it("rejects too few and repeated competitors", () => {
  expect(validateQuantParams({...DEFAULT_QUANT_PARAMS,quantKind:"multi_factor"})).toBeTruthy()
  expect(validateQuantParams({...DEFAULT_QUANT_PARAMS,quantKind:"multi_factor",factorRecipe:{groups:[[0],[0]],weights:[1,1]}})).toBeTruthy()
})
