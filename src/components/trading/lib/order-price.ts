/**
 * 下单价格：对手价计算与价格带
 */

import type { OrderDirection } from "@/types"

/** 价格模式 */
export type PriceMode = "opponent" | "manual"

/**
 * 对手价：买→卖一，卖→买一；缺失用最新价
 */
export function resolveOpponentPrice(
  direction: OrderDirection,
  bid: number,
  ask: number,
  last: number
): number {
  if (direction === "buy") {
    return ask > 0 ? ask : last
  }
  if (direction === "sell") {
    return bid > 0 ? bid : last
  }
  return bid > 0 ? bid : last
}

/** 相对最新价 ±10% 价格带 */
export function priceBand(lastPrice: number): {
  min: number
  max: number
  inBand: (price: number) => boolean
} {
  if (lastPrice <= 0) {
    return {
      min: 0,
      max: 0,
      inBand: () => true,
    }
  }
  const min = lastPrice * 0.9
  const max = lastPrice * 1.1
  return {
    min,
    max,
    inBand: (price: number) =>
      price <= 0 ? true : price >= min && price <= max,
  }
}
