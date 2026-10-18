import type { DailyPnlRow, DailyPnlSummary } from "./live-api"
import type { PaperOrderItem } from "./paper-api"

export function dailyNetPnl(row: DailyPnlRow): number {
  if (row.net_after_costs != null && Number.isFinite(row.net_after_costs)) return row.net_after_costs
  return row.pnl - (row.fee_cost ?? row.fee) + (row.funding ?? 0)
}

/** The transport keeps legacy gross fields; every displayed chart/summary uses
 * the same authoritative after-cost value as the dashboard's daily metric. */
export function netDailyPnlView<T extends {days:DailyPnlRow[];summary:DailyPnlSummary|null}>(result:T):T{
  let cumulative=0,profit=0,loss=0
  const days=result.days.map(row=>{
    const net=dailyNetPnl(row)
    cumulative+=net;profit+=Math.max(0,net);loss+=Math.min(0,net)
    return {...row,net,cumulative}
  })
  return {...result,days,summary:result.summary?{...result.summary,net:cumulative,total_profit:profit,total_loss:loss,profit_ratio:loss<0?profit/Math.abs(loss):null}:null}
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
