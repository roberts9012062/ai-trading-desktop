import { it, expect, vi } from 'vitest'
import { retainVisibleChart, visibleCharts, onVisibleChartsChange } from './visible-charts'

it('keeps a mounted chart subscribed through a slow initial load and releases it immediately', () => {
  vi.useFakeTimers()
  const changed = vi.fn(), stop = onVisibleChartsChange(changed)
  const release = retainVisibleChart('BTCUSDT', '1m')
  vi.advanceTimersByTime(120000)
  expect(visibleCharts()).toEqual([{ symbol: 'btcusdt', period: '1m' }])
  release()
  expect(visibleCharts()).toEqual([])
  expect(changed).toHaveBeenCalledTimes(2)
  stop(); vi.useRealTimers()
})
it('prioritizes the newest visible chart and reference counts split panes', () => {
  const a = retainVisibleChart('btcusdt', '1m'), b = retainVisibleChart('ethusdt', '5m')
  const again = retainVisibleChart('btcusdt', '1m')
  a()
  expect(visibleCharts()).toEqual([{ symbol: 'ethusdt', period: '5m' }, { symbol: 'btcusdt', period: '1m' }])
  b(); again(); again()
  expect(visibleCharts()).toEqual([])
})
