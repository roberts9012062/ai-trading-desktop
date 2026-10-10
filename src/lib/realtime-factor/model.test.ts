import { describe, it, expect } from 'vitest'
import { appendAnalysis, mergeCandle, refreshEnrichment, healthy, intentForScore } from './model'

describe('realtime factor', () => {
  it('retains exactly the newest 50 analyses per task', () => {
    let rows: Array<{ id: number }> = []
    for (let id=0; id<80; id++) rows=appendAnalysis(rows,{id})
    expect(rows).toHaveLength(50)
    expect(rows[0].id).toBe(79)
    expect(rows[49].id).toBe(30)
  })
  it('replaces the forming candle without appending every second and retains enriched fields', () => {
    const rows=[{time:'2026-10-10 10:00:00',open:10,high:10,low:9,close:9,volume:20,funding_rate:0.001,is_closed:false}]
    const next=mergeCandle(rows,{time:rows[0].time,open:10,high:11,low:9,close:11,volume:30,is_closed:false},600)
    expect(next).toHaveLength(1)
    expect(next[0].funding_rate).toBe(0.001)
    expect(next[0].close).toBe(11)
  })
  it('does not overwrite confirmed history with late unconfirmed candles', () => {
    const closed={time:'2026-10-10 10:00:00',open:10,high:11,low:9,close:10,volume:30,is_closed:true}
    expect(mergeCandle([closed],{...closed,close:9,is_closed:false},600)[0]).toEqual(closed)
  })
  it('forward fills slow derivatives into a new forming candle without copying old volume', () => {
    const old={time:'2026-10-10 10:00:00',open:10,high:11,low:9,close:10,volume:300,is_closed:true,open_interest:1000,funding_rate:0.001}
    const bar={time:'2026-10-10 10:15:00',open:10,high:10,low:10,close:10,volume:2,is_closed:false}
    const next=mergeCandle([old],bar,600)
    expect(next[1].open_interest).toBe(1000)
    expect(next[1].funding_rate).toBe(0.001)
    expect(next[1].volume).toBe(2)
  })
  it('stops renewing when computation or feed is stale', () => {
    expect(healthy(10000,9800,9900,1)).toBe(true)
    expect(healthy(10000,6000,9900,1)).toBe(false)
    expect(healthy(10000,9900,4000,5)).toBe(false)
  })
  it('refreshes slow server fields without reverting live prices or volume', () => {
    const bar={time:'2026-10-10 10:15:00',open:10,high:11,low:9,close:10,volume:2,is_closed:false}
    const next=refreshEnrichment([{...bar,open_interest:1200,funding_rate:0.002}], [{...bar,close:11,volume:8,open_interest:1000,funding_rate:0.001}],600)
    expect(next[0].close).toBe(11)
    expect(next[0].volume).toBe(8)
    expect(next[0].open_interest).toBe(1200)
    expect(next[0].funding_rate).toBe(0.002)
  })
  it('closes the opposite fractional position before opening and holds same direction', () => {
    const task={side_mode:'both',close_rules:{},position_qty:0.005,position_direction:'short'}
    expect(intentForScore(task,0.7)).toBe('close')
    expect(intentForScore(task,-0.7)).toBe('hold')
    expect(intentForScore({...task,position_qty:0},-0.7)).toBe('open_short')
  })
})
