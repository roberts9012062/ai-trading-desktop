/** 持仓浮动盈亏估算（虚拟盘用；实盘优先交易所权威 unrealized_pnl） */

import type { PaperPositionItem } from "@/lib/paper-api"

/** 用最新价估算浮动盈亏；无有效价时回退持仓自带盈亏字段 */
export function estimatePositionPnl(
  pos: PaperPositionItem,
  last: number | undefined
): number {
  if (last == null || !Number.isFinite(last) || last <= 0) {
    return Number(pos.unrealized_pnl ?? pos.realized_pnl) || 0
  }
  const mult = Number(pos.multiplier) || 1
  const qty = Number(pos.quantity) || 0
  const avg = Number(pos.avg_price) || 0
  if (pos.direction === "long") {
    return (last - avg) * qty * mult
  }
  return (avg - last) * qty * mult
}

/** 持仓浮动盈亏：实盘取交易所值，虚拟盘用 WS 最新价估算 */
export function positionPnl(
  pos: PaperPositionItem,
  mode: "live" | "virtual",
  last: number | undefined
): number {
  if (mode === "live" && pos.unrealized_pnl != null) {
    return Number(pos.unrealized_pnl) || 0
  }
  return estimatePositionPnl(pos, last)
}
