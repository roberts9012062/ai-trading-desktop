"use client"

import { useEffect, useState, type MutableRefObject, type RefObject } from "react"
import type { IChartApi, ISeriesApi, Time } from "lightweight-charts"
import { getKlineApi } from "@/lib/api"
import { useMarketStore } from "@/stores/market"
import { intradayDayStart, loadIntradayHistory, mergeIntraday, type IntradayPoint } from "./intraday"
import { makeChartOpts } from "./utils"

const cache = new Map<string, { at: number; result: Awaited<ReturnType<typeof loadIntradayHistory>> }>()
const inflight = new Map<string, ReturnType<typeof loadIntradayHistory>>()
function history(symbol: string, now: number) {
  const key = `${symbol}:${intradayDayStart(now)}`
  const cached = cache.get(key)
  if (cached && Date.now() - cached.at < 60000) return Promise.resolve(cached.result)
  if (inflight.has(key)) return inflight.get(key)!
  const request = loadIntradayHistory(options => getKlineApi(symbol, "1m", options), now)
    .then(result => {
      if (cache.size >= 12) cache.delete(cache.keys().next().value!)
      cache.set(key, { at: Date.now(), result })
      return result
    }).finally(() => inflight.delete(key))
  inflight.set(key, request)
  return request
}

export function useIntradayChart({ symbol, enabled, seriesReady, chart, series, points }: {
  symbol: string; enabled: boolean; seriesReady: number
  chart: RefObject<IChartApi | null>; series: MutableRefObject<ISeriesApi<"Line"> | null>
  points: MutableRefObject<IntradayPoint[]>
}): string {
  const quote = useMarketStore(s => s.quotes[symbol] ?? s.quotes[symbol.toLowerCase()])
  const connection = useMarketStore(s => s.connectionState)
  const [day, setDay] = useState(() => intradayDayStart(Date.now() / 1000))
  const [status, setStatus] = useState("")
  useEffect(() => {
    if (!enabled) return
    const timer = setInterval(() => setDay(intradayDayStart(Date.now() / 1000)), 10000)
    return () => clearInterval(timer)
  }, [enabled])
  useEffect(() => {
    if (!enabled || !series.current || !chart.current) return
    let disposed = false
    points.current = []
    series.current.setData([])
    const timeLabel = (time: Time) => typeof time === "number"
      ? new Date((time + 8 * 3600) * 1000).toISOString().slice(11, 16) : String(time)
    chart.current.applyOptions({ timeScale: { tickMarkFormatter: timeLabel }, localization: { timeFormatter: timeLabel } })
    setStatus("加载当日分时…")
    void history(symbol, Date.now() / 1000).then(result => {
      if (disposed || !series.current) return
      points.current = mergeIntraday(result.points, points.current, Date.now() / 1000)
      series.current.setData(points.current.map(p => ({ ...p, time: p.time as Time })))
      chart.current?.timeScale().fitContent()
      setStatus(result.complete ? "" : "部分历史暂未加载，可切换周期重试")
    }).catch(() => { if (!disposed) setStatus("分时历史加载失败，实时价格继续更新；可切换周期重试") })
    return () => {
      disposed = true
      const options = makeChartOpts()
      chart.current?.applyOptions({ timeScale: { tickMarkFormatter: options.timeScale.tickMarkFormatter }, localization: { timeFormatter: options.localization.timeFormatter } })
    }
  }, [symbol, enabled, seriesReady, day, connection, chart, series, points])
  useEffect(() => {
    if (!enabled || !series.current || !quote || quote.last_price <= 0) return
    const now = Date.now() / 1000
    const received = quote.recv_ts ? (quote.recv_ts > 1e12 ? quote.recv_ts / 1000 : quote.recv_ts) : NaN
    if (!Number.isFinite(received) || now - received > 120 || received > now + 30) return
    const updates = mergeIntraday([], [{ time: received, value: quote.last_price }], now)
    if (!updates.length) return
    points.current = mergeIntraday(points.current, updates, now)
    series.current.applyOptions({ priceFormat: { type: "price", precision: quote.decimal_places, minMove: 10 ** -quote.decimal_places } })
    series.current.setData(points.current.map(p => ({ ...p, time: p.time as Time })))
  }, [quote, symbol, enabled, seriesReady, day, series, points])
  return enabled ? status : ""
}
