import type { EvolutionRecipe } from "./factor-evolution-api"
import type { PortfolioResult } from "./factor-lab-api"

/** Drop zero-weight IC members, preserving the actual executable combination. */
export function evolutionPortfolioRecipe(portfolio: PortfolioResult): EvolutionRecipe {
  const groups = portfolio.members || []
  const frozen = portfolio.pass_mode === "ic_weighted" ? portfolio.ic_weights : null
  const weights = frozen && frozen.length === groups.length ? frozen : groups.map(() => 1 / groups.length)
  const active = groups.map((tokens, i) => ({tokens, weight: weights[i]})).filter(g => Number.isFinite(g.weight) && g.weight > 0)
  const total = active.reduce((sum, g) => sum + g.weight, 0)
  return {groups: active.map(g => g.tokens), weights: active.map(g => g.weight / total),
    rationale: portfolio.pass_mode === "ic_weighted" && !frozen ? "旧组合未保存 IC 权重，本次以成员等权作为重新优化的起点。" : "以收藏的组合成员和冻结权重作为进化起点。"}
}
