import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import type { PortfolioResult } from "@/lib/factor-lab-api"
import { PortfolioCard } from "./portfolio-card"
import { ChampionTable } from "./champion-table"

const metrics = { ann_ret: .543, sortino: 1.89, calmar: 1 }
const portfolio: PortfolioResult = {
  n_factors: 4, avg_abs_corr: .366, equal: metrics, best_single: metrics,
  combo_super: true, combo_source: "rescued", super_passed: true,
  members: [[0], [1], [0, 1, 64], [0, 1, 65]],
}

describe("passed portfolio members", () => {
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
