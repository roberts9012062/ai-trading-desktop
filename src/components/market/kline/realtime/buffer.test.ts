import { it, expect, vi } from 'vitest'
import type { ISeriesApi } from 'lightweight-charts'
import { applyBarToSeries, applyBarsToSeries } from './buffer'

it('updates the current candle after a minute rollover without replaying earlier tail candles', () => {
  const latest=Date.parse('2026-10-18T18:21:00Z')/1000
  const update=vi.fn((bar:{time:number})=>{if(bar.time<latest)throw new Error('Cannot update oldest data')})
  const series={data:()=>[{time:latest}],update} as unknown as ISeriesApi<'Candlestick'>
  const bars=['2026-10-18 18:20:00','2026-10-18 18:21:00'].map(time=>({time,open:100,high:102,low:99,close:101,volume:3}))
  expect(()=>{for(const bar of bars)applyBarToSeries(series,{current:null},bar,'1m')}).toThrow('Cannot update oldest data')
  update.mockClear()
  applyBarsToSeries(series,{current:null},bars,'1m')
  expect(update).toHaveBeenCalledTimes(1)
  expect(update.mock.calls[0][0].time).toBe(latest)
})
it('compares daily business-day objects and still applies the latest candle', () => {
  const update=vi.fn()
  const series={data:()=>[{time:{year:2026,month:10,day:18}}],update} as unknown as ISeriesApi<'Candlestick'>
  const bars=['2026-10-17','2026-10-18'].map(time=>({time,open:100,high:102,low:99,close:101,volume:3}))
  applyBarsToSeries(series,{current:null},bars,'1d')
  expect(update).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({time:'2026-10-18'}))
})
