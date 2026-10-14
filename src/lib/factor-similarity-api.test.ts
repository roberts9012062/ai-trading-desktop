import {afterEach, expect, it, vi} from "vitest"
import {analyzeFactorSimilarity} from "./factor-lab-api"
import {serverFactorFormulaKey} from "./factor-access"
import {DEFAULT_QUANT_PARAMS, validateQuantParams} from "./quant-strategy"
afterEach(() => vi.unstubAllGlobals())
it("converts desktop favorite formulas before calling the server similarity evaluator", async () => {
  const fetcher = vi.fn().mockResolvedValue({ok:true, status:200, json:async () => ({pairs:[]})})
  vi.stubGlobal("fetch", fetcher)
  await analyzeFactorSimilarity({symbol:"btcusdt", timeframe:"15m", token_groups:[[54,71],[62]]})
  const body = JSON.parse(fetcher.mock.calls[0]![1].body)
  expect(body.token_groups).toEqual([[75,135],[83,135,135]])
})
it("preserves already converted formulas supplied by existing combination panels and cloned tasks", async () => {
  const fetcher = vi.fn().mockResolvedValue({ok:true,status:200,json:async () => ({pairs:[]})})
  vi.stubGlobal("fetch", fetcher)
  await analyzeFactorSimilarity({symbol:"btcusdt",timeframe:"60m",token_groups:[[75,135],[83,135,135]]})
  expect(JSON.parse(fetcher.mock.calls[0]![1].body).token_groups).toEqual([[75,135],[83,135,135]])
})
it("matches cloned formulas to desktop favorites and rejects mixed-dialect duplicates", () => {
  expect(serverFactorFormulaKey([54,71])).toBe(serverFactorFormulaKey([75,135]))
  expect(validateQuantParams({...DEFAULT_QUANT_PARAMS,quantKind:"multi_factor",factorRecipe:{groups:[[54,71],[75,135]],weights:[1,1]}})).toBe("请选择不同的因子公式")
})
