import type { PaperOrderItem } from './paper-api'

function identity(o: PaperOrderItem): string {
  return o.order_kind === 'algo'
    ? `algo:${o.algo_id || o.id}`
    : `regular:${o.exchange_order_id || o.id}`
}

export function canCancelLiveOrder(o: PaperOrderItem): boolean {
  return o.order_kind !== 'algo' && o.can_cancel !== false &&
    (o.status === 'pending' || o.status === 'partially_filled')
}

export function mergeLiveOrders(open: PaperOrderItem[], history: PaperOrderItem[]): PaperOrderItem[] {
  const seen = new Set(open.map(identity))
  const result = [...open]
  for (const row of history) {
    const key = identity(row)
    if (seen.has(key)) continue
    seen.add(key)
    // Absence from a snapshot proves neither cancellation nor a full fill.
    const active = row.status === 'pending' || row.status === 'partially_filled'
    result.push(active ? { ...row, status:'unconfirmed',can_cancel:false,can_amend:false } : row)
  }
  return result
}
