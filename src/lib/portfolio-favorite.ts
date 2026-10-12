import type { FactorFavoriteItem, PortfolioResult } from "./factor-lab-api"

export function isSingleFactorFavorite(item: FactorFavoriteItem): item is FactorFavoriteItem & { tokens: number[] } {
  return item.tokens.length > 0 && item.tokens.every(token => typeof token === "number")
}

/** Keep the same separate identity space as the server's tokens_key_any. */
export function favoriteTokensKey(tokens: number[] | number[][]): string {
  return Array.isArray(tokens[0])
    ? `combo:${(tokens as number[][]).map(group => group.join(",")).join("|")}`
    : tokens.join(",")
}

export function portfolioMode(portfolio: PortfolioResult): "equal" | "ic_weighted" {
  return portfolio.pass_mode === "ic_weighted" ? "ic_weighted" : "equal"
}

export function portfolioMetrics(portfolio: PortfolioResult) {
  return portfolioMode(portfolio) === "ic_weighted" ? portfolio.ic_weighted : portfolio.equal
}

export function portfolioFavoritePayload(portfolio: PortfolioResult, symbol: string, timeframe: string) {
  const members = portfolio.members
  const metrics = portfolioMetrics(portfolio)
  if (!symbol || !timeframe) throw new Error("缺少组合的品种或周期，无法收藏")
  if (!portfolio.super_passed || !metrics || !members || members.length < 2 || members.some(group => !group.length)) {
    throw new Error("组合尚未通过验收或成员数据不完整，无法收藏为超级因子")
  }
  const mode = portfolioMode(portfolio) === "ic_weighted" ? "IC 加权" : "等权"
  return {
    tokens: members,
    text: `${mode}组合(${members.length}) · ${portfolio.member_details?.map(member => member.text).join(" / ") || JSON.stringify(members)}`,
    name: `超级因子·${symbol}·${timeframe}·${mode}`,
    symbol,
    timeframe,
    // Portfolio scoring has no single-factor composite or IC. Preserve only actual measurements.
    metrics: { ...metrics, portfolio_snapshot: portfolio },
  }
}
