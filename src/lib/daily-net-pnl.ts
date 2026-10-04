import type { DailyPnlRow } from "./live-api"
import type { PaperOrderItem } from "./paper-api"

export function dailyNetPnl(row: DailyPnlRow): number {
  if (row.net_after_costs != null && Number.isFinite(row.net_after_costs)) return row.net_after_costs
  return row.pnl - (row.fee_cost ?? row.fee) + (row.funding ?? 0)
}

export function paperTodayNetPnl(orders: PaperOrderItem[], now = Date.now()) {
  const date = (ms: number) => new Date(ms + 8 * 3600_000).toISOString().slice(0, 10)
  const today = date(now)
  let gross = 0, fee = 0, count = 0
  for (const order of orders) {
    if (order.status !== "filled" && !(order.filled_qty > 0)) continue
    const ts = new Date(order.filled_at || order.updated_at || order.created_at).getTime()
    if (!Number.isFinite(ts) || ts > now || date(ts) !== today) continue
    fee += Number(order.fee || 0)
    if (order.offset === "close") {
      gross += Number(order.realized_pnl || 0)
      count++
    }
  }
  return { sum: gross - fee, fee, count, funding: 0, win: null, loss: null }
}
