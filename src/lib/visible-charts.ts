import type { ChartSubscriptionKey } from './websocket'

// A mounted chart owns its subscription, even while history is still loading.
const charts = new Map<string, { chart: ChartSubscriptionKey; count: number }>()
const listeners = new Set<() => void>()
export function visibleCharts(): ChartSubscriptionKey[] {
  return [...charts.values()].reverse().map(entry => entry.chart)
}
export function onVisibleChartsChange(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
export function retainVisibleChart(symbol: string, period: string): () => void {
  const chart = { symbol: symbol.toLowerCase(), period }, key = `${chart.symbol}:${period}`
  const previous = charts.get(key)
  charts.set(key, { chart, count: (previous?.count ?? 0) + 1 })
  listeners.forEach(listener => listener())
  let released = false
  return () => {
    if (released) return
    released = true
    const entry = charts.get(key)
    if (entry && entry.count > 1) entry.count--
    else charts.delete(key)
    listeners.forEach(listener => listener())
  }
}
