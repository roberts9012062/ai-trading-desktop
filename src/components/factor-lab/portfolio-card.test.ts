import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import type { PortfolioResult } from "@/lib/factor-lab-api"
import { PortfolioCard } from "./portfolio-card"
import { ChampionTable } from "./champion-table"
import { championFromFavorite } from "./hooks/factor-helpers"
import type { FactorFavoriteItem } from "@/lib/factor-lab-api"

const metrics = { ann_ret: .543, sortino: 1.89, calmar: 1 }
const portfolio: PortfolioResult = {
  n_factors: 4, avg_abs_corr: .366, equal: metrics, best_single: metrics,
  combo_super: true, combo_source: "rescued", super_passed: true,
  members: [[0], [1], [0, 1, 64], [0, 1, 65]],
}

describe("passed portfolio members", () => {
  it("puts a combination first in Champion ranking, even without any single champions", () => {
    const props = { champions: [], selectedTokens: null, onSelect: () => {}, onFavorite: null, portfolio, comboSymbol: "xrpusdt", comboTimeframe: "1h" }
    const html = renderToStaticMarkup(createElement(ChampionTable, props))
    expect(html).toContain("★ 超级因子")
    expect(html).toContain("查看数据")
    expect(html).not.toContain("暂无结果")
    const single = championFromFavorite({ tokens: [0], text: "SINGLE_FORMULA", metrics: {}, composite: 1 } as FactorFavoriteItem)
    const ranked = renderToStaticMarkup(createElement(ChampionTable, { ...props, champions: [single] }))
    expect(ranked.indexOf("★ 超级因子")).toBeLessThan(ranked.indexOf("SINGLE_FORMULA"))
  })

  it("shows the IC-weighted passed measurements rather than a failed equal mode", () => {
    const html = renderToStaticMarkup(createElement(ChampionTable, {
      champions: [], selectedTokens: null, onSelect: () => {}, onFavorite: null,
      portfolio: { ...portfolio, pass_mode: "ic_weighted", equal: { ...metrics, ann_ret: -.55 }, ic_weighted: { ...metrics, ann_ret: .125 } },
    }))
    expect(html).toContain("IC 加权")
    expect(html).toContain("12.5%")
    expect(html).not.toContain("-55.0%")
  })
  it("shows every rescued member of an existing completed task without single champions or formula metadata", () => {
    const html = renderToStaticMarkup(createElement(PortfolioCard, { portfolio }))
    expect(html).toContain("超级因子成员（4）")
    for (const tokens of portfolio.members!) expect(html).toContain(JSON.stringify(tokens))
    expect(html).toContain("复制成员 tokens")
    expect(html).toContain("单因子资格独立判断")
  })

  it("shows captured formulas and individual qualification without relabeling rejected members", () => {
    const detailed = { ...portfolio, member_details: [
      { tokens: [1], text: "RET_5", qualification_status: "rejected", rejection_reasons: ["wf_oos_fold_failed"] },
      { tokens: [0], text: "RET_1", qualification_status: "qualified", rejection_reasons: [] },
    ] } as PortfolioResult
    const html = renderToStaticMarkup(createElement(PortfolioCard, { portfolio: detailed }))
    expect(html).toContain("RET_1")
    expect(html).toContain("RET_5")
    expect(html.indexOf("RET_1")).toBeLessThan(html.indexOf("RET_5"))
    expect(html).toContain("单因子未通过")
    expect(html).toContain("单因子合格")
  })

  it("does not present a failed combination as a passed super factor", () => {
    const html = renderToStaticMarkup(createElement(PortfolioCard, { portfolio: { ...portfolio, super_passed: false } }))
    expect(html).not.toContain("超级因子成员")
    expect(html).toContain("组合测试未通过")
  })

  it("lets completed tasks explain an empty single-factor table while retaining the initial search prompt", () => {
    const props = { champions: [], selectedTokens: null, onSelect: () => {}, onFavorite: null }
    const message = "暂无单独通过验收的冠军因子；已通过的超级因子及成员见上方组合结果"
    const html = renderToStaticMarkup(createElement(ChampionTable, { ...props, emptyMessage: message }))
    expect(html).toContain(message)
    expect(html).not.toContain("先配置参数")
    expect(renderToStaticMarkup(createElement(ChampionTable, props))).toContain("先配置参数")
  })
})
