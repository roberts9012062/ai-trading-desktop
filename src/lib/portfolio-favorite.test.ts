import { afterEach, describe, expect, it, vi } from "vitest"
import { addFactorFavorite, type FactorFavoriteItem, type PortfolioResult } from "./factor-lab-api"
import { favoriteTokensKey, isSingleFactorFavorite, portfolioFavoritePayload } from "./portfolio-favorite"
import { championFromFavorite } from "@/components/factor-lab/hooks/factor-helpers"

const equal = { ann_ret: -.15, sortino: -.8, calmar: -.2 }
const weighted = { ann_ret: .25, sortino: 1.9, calmar: 1.2 }
const portfolio: PortfolioResult = {
  n_factors: 2, avg_abs_corr: .25, equal, ic_weighted: weighted, best_single: equal,
  equal_2x: equal, ic_weighted_2x: { ...weighted, sortino: .9 },
  members: [[4, 94, 71], [47, 94, 71]],
  combo_super: true, super_passed: true, pass_mode: "ic_weighted", segment: "holdout", eval_bars: 600,
  wf_fold_sortinos: [-1, .8, 1.5], wf_fold_sortinos_ic: [1.1, .9, 1.8],
}

afterEach(() => vi.unstubAllGlobals())

describe("portfolio favorite persistence", () => {
  it("retains all members and both modes, reports the actual passed IC mode, and invents no composite", () => {
    const payload = portfolioFavoritePayload(portfolio, "xrpusdt", "1h")
    expect(payload.tokens).toEqual(portfolio.members)
    expect(payload.metrics.ann_ret).toBe(.25)
    expect(payload.metrics.sortino).toBe(1.9)
    expect(payload.metrics.portfolio_snapshot).toEqual(portfolio)
    expect(payload).not.toHaveProperty("composite")
    expect(payload.name).toContain("IC 加权")
  })

  it("keeps combination identity separate from a flattened formula", () => {
    expect(favoriteTokensKey([[0], [1, 64]])).toBe("combo:0|1,64")
    expect(favoriteTokensKey([[0], [1, 64]])).not.toBe(favoriteTokensKey([0, 1, 64]))
  })

  it("sends and reads back nested tokens and the assessment snapshot through the existing API", async () => {
    const payload = portfolioFavoritePayload(portfolio, "xrpusdt", "1h")
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => ({
      ok: true, status: 200,
      json: async () => ({ id: "combo-favorite", ...JSON.parse(String(init.body)) }),
    }))
    vi.stubGlobal("fetch", fetchMock)
    const saved = await addFactorFavorite(payload)
    expect(fetchMock.mock.calls[0][0]).toContain("/api/factor-lab/favorites")
    expect(saved.tokens).toEqual(portfolio.members)
    expect(saved.metrics?.portfolio_snapshot?.wf_fold_sortinos_ic).toEqual([1.1, .9, 1.8])
    expect(isSingleFactorFavorite(saved)).toBe(false)
    expect(() => championFromFavorite(saved)).toThrow("不能作为单因子回测")
  })

  it("keeps single-formula favorites compatible", () => {
    const single = { tokens: [4, 94, 71], composite: 2, text: "RET", metrics: {} } as FactorFavoriteItem
    expect(isSingleFactorFavorite(single)).toBe(true)
    expect(championFromFavorite(single).tokens).toEqual([4, 94, 71])
  })

  it("rejects failed, incomplete or missing-mode combinations instead of saving a false super factor", () => {
    for (const bad of [
      { ...portfolio, super_passed: false }, { ...portfolio, members: [[0]] },
      { ...portfolio, members: [[0], []] }, { ...portfolio, ic_weighted: null },
    ]) expect(() => portfolioFavoritePayload(bad, "xrpusdt", "1h")).toThrow()
    expect(() => portfolioFavoritePayload(portfolio, "", "1h")).toThrow()
  })
})
