/**
 * 成交/委托动作中文文案
 * 统一：买多 · 卖空 · 平仓
 */

/** 模拟盘委托：direction + offset → 中文动作 */
export function paperActionLabel(
  direction: string,
  offset: string,
): string {
  if (offset === "close") {
    return "平仓"
  }
  if (direction === "buy") {
    return "买多"
  }
  return "卖空"
}

/** 行情成交明细：主动买/卖 → 中文 */
export function marketTickDirectionLabel(direction: string): string {
  return direction === "buy" ? "买多" : "卖空"
}

/** AI/量化决策 action 字段 → 中文 */
export function decisionActionLabel(action: string): string {
  const map: Record<string, string> = {
    hold: "观望",
    open_long: "买多",
    open_short: "卖空",
    close: "平仓",
    close_long: "平仓",
    close_short: "平仓",
    buy: "买多",
    sell: "卖空",
    error: "错误",
  }
  return map[action] ?? action
}

/** 是否偏多（用于涨跌色） */
export function isBullishActionLabel(label: string): boolean {
  return label.includes("多")
}
