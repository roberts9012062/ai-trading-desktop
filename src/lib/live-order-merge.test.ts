import { describe, expect, it } from 'vitest'
import type { PaperOrderItem } from './paper-api'
import { mergeLiveOrders, canCancelLiveOrder } from './live-order-merge'

const order = (values: Partial<PaperOrderItem> = {}): PaperOrderItem => ({
  id:'local', exchange_order_id:'native', symbol:'ethusdt',symbol_name:'ETH',direction:'buy',offset:'open',
  order_type:'limit',price:100,quantity:1,filled_qty:0,status:'pending',source:'manual',frozen_margin:0,
  fee:0,realized_pnl:0,created_at:'',updated_at:'',filled_at:null,...values,
})
describe('live order truth', () => {
  it('absence and query failure never invent cancellation or mutate mirrors', () => {
    const mirror = order()
    expect(mergeLiveOrders([], [mirror])[0].status).toBe('unconfirmed')
    expect(mirror.status).toBe('pending')
    expect(mergeLiveOrders([], [order({filled_qty:1})])[0].status).toBe('unconfirmed')
  })
  it('deduplicates forecasts by algo identity while retaining regular orders with the same id', () => {
    const algo = order({id:'algo:native',order_kind:'algo',algo_id:'native',exchange_order_id:''})
    const rows = mergeLiveOrders([order(), algo], [order({id:'mirror',order_kind:'algo',algo_id:'native',exchange_order_id:''})])
    expect(rows).toHaveLength(2)
    expect(rows[1].status).toBe('pending')
    expect(canCancelLiveOrder(rows[1])).toBe(false)
    expect(canCancelLiveOrder(rows[0])).toBe(true)
  })
})
