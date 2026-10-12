import { beforeEach, describe, expect, it, vi } from "vitest"
import { attachEvolutionFunding } from "./factor-evolution-funding"
import { evolutionPortfolioRecipe } from "./factor-evolution-recipe"
import { readFactorValidation, writeFactorValidation } from "./factor-validation-settings"
import { buildStrategyParams, paramsToQuantState, DEFAULT_QUANT_PARAMS } from "./quant-strategy"
import type { PortfolioResult } from "./factor-lab-api"

describe("evolution evidence and execution boundaries", () => {
  beforeEach(() => {
    const data = new Map<string, string>()
    vi.stubGlobal("localStorage", {getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => data.set(key, value)})
  })
  it("shares lab settings without confusing a collapsed panel with disabling validation", () => {
    expect(readFactorValidation().walk_forward_folds).toBe(3)
    writeFactorValidation({enabled: true, train_ratio: .6, test_recent_bars: 600, walk_forward_folds: 4})
    expect(readFactorValidation()).toEqual({enabled: true, train_ratio: .6, test_recent_bars: 600, walk_forward_folds: 4})
    localStorage.setItem("factor-lab-validation:local", '{"enabled":true,"train_ratio":0.8,"walk_forward_folds":1000}')
    expect(readFactorValidation().walk_forward_folds).toBe(3)
  })
  it("keeps all settlements inside a daily candle and deduplicates actual events", () => {
    const day = Date.parse("2026-01-01T00:00:00Z")
    const bars = [0, 1, 2].map(i => ({time: new Date(day + i * 86400000).toISOString(), open_time: day + i * 86400000, open: 100, high: 101, low: 99, close: 100, volume: 1}))
    const events = [0, 8, 16, 24, 32, 40].map(i => ({t: day + i * 3600000, r: .001}))
    const result = attachEvolutionFunding(bars, [...events, events[0]])
    expect(result[0].funding_events).toHaveLength(3)
    expect(result[1].funding_events).toHaveLength(3)
    expect(result[2].funding_events).toHaveLength(0)
  })
  it("preserves positive IC weights and removes inactive members", () => {
    const recipe = evolutionPortfolioRecipe({members: [[9], [62], [63]], pass_mode: "ic_weighted", ic_weights: [.8, 0, .2]} as PortfolioResult)
    expect(recipe.groups).toEqual([[9], [63]])
    expect(recipe.weights).toEqual([.8, .2])
    expect(evolutionPortfolioRecipe({members: [[9], [62]], pass_mode: "ic_weighted"} as PortfolioResult).rationale).toContain("未保存")
  })
  it("editing a frozen shortline task preserves every member, weight and risk setting", () => {
    const champions = [{id: 1, tokens: [83,151], weight: .8}, {id: 2, tokens: [9,135,135], weight: .2}]
    const state = paramsToQuantState("shortline_factor", {shortline: {champions, cadence_seconds: 7, decision: {threshold: .4}, risk: {daily_loss_limit_usdt: 90}}})
    expect(buildStrategyParams(state).champions).toEqual(champions)
    expect(state.slCadenceSec).toBe(7)
    expect(state.slThreshold).toBe(.4)
    expect(state.slDailyLoss).toBe(90)
  })
  it("a selected shortline combination stays a combination when mounted", () => {
    const recipe = {groups: [[9, 87], [62, 87]], weights: [.8, .2]}
    const params = buildStrategyParams({...DEFAULT_QUANT_PARAMS, quantKind: "shortline_factor", factorRecipe: recipe, factorTokensText: "9,87\n62,87"})
    expect(params.champions).toEqual([{id: 1, tokens: [9, 87], weight: .8}, {id: 2, tokens: [62, 87], weight: .2}])
    expect(params).not.toHaveProperty("factor_tokens")
  })
})
