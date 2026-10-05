/** Official OKX chart stream, with per-key REST recovery. Task feeds are unchanged. */
import { getKlineApi } from "@/lib/api"
import { useMarketStore } from "@/stores/market"
import { listActiveRtKeys, offerRtBar } from "@/components/market/kline/realtime/accumulator"
import { getMarketWebSocket, type ChartSubscriptionKey, type WsMessage } from "./websocket"
import type { KlineBar, KlinePeriod } from "@/types"

const POLL_MS = 3_000
const IDLE_MS = 30_000
const STREAM_STALE_MS = 4_500
const DELAYS = [POLL_MS, 2 * POLL_MS, 5 * POLL_MS]
let timer: ReturnType<typeof setTimeout> | null = null
const fallbackFlights = new Map<string, Promise<void>>()
let unsubscribe: (() => void)[] = []
let activeKeys = new Set<string>()
const streamHeads = new Map<string, { at: number; version: number; time: string }>()
const retries = new Map<string, { failures: number; after: number }>()
const keyOf = ({ symbol, period }: ChartSubscriptionKey) => `${symbol}:${period}`

function applyFrames(symbol: string, period: string, bars: KlineBar[]): void {
  for (const bar of bars) offerRtBar(symbol, period, bar)
  useMarketStore.getState().updateKlineRealtime(bars.map(bar => ({ symbol, period: period as KlinePeriod, bar })))
}

function validBar(bar: KlineBar): boolean {
  if (!bar || bar.market_source !== "okx" || typeof bar.time !== "string" || !bar.time ||
      typeof bar.version !== "number" || !Number.isFinite(bar.version) || bar.version <= 0) return false
  const values = [bar.open, bar.high, bar.low, bar.close, bar.volume]
  return values.every(v => typeof v === "number" && Number.isFinite(v)) &&
    Math.min(bar.open, bar.high, bar.low, bar.close) > 0 && bar.volume >= 0 &&
    bar.high >= Math.max(bar.open, bar.low, bar.close) && bar.low <= Math.min(bar.open, bar.high, bar.close)
}

function receiveChart(message: WsMessage): void {
  if (message.type !== "chart_kline" || !Array.isArray(message.data) || getMarketWebSocket().state !== "connected") return
  const groups = new Map<string, { symbol: string; period: string; bars: KlineBar[] }>()
  for (const frame of message.data) {
    if (!frame || typeof frame.symbol !== "string" || typeof frame.period !== "string") continue
    const key = keyOf(frame)
    if (!activeKeys.has(key)) continue
    const group: { symbol: string; period: string; bars: KlineBar[] } = groups.get(key) ?? { symbol: frame.symbol, period: frame.period, bars: [] }
    group.bars.push(frame.bar)
    groups.set(key, group)
  }
  for (const [key, group] of groups) {
    if (!group.bars.length || group.bars.length > 3 || !group.bars.every(validBar)) continue
    const bars = group.bars.sort((a, b) => a.time.localeCompare(b.time))
    if (new Set(bars.map(b => b.time)).size !== bars.length) continue
    const latest = bars[bars.length - 1], prev = streamHeads.get(key)
    if (prev && (latest.version! < prev.version || latest.time < prev.time)) continue
    applyFrames(group.symbol, group.period, bars)
    streamHeads.set(key, { at: Date.now(), version: latest.version!, time: latest.time })
    retries.delete(key)
  }
}

async function pollOnce(): Promise<void> {
  const keys = listActiveRtKeys(IDLE_MS).filter(({ symbol, period }) =>
    /^[a-z0-9]{1,16}usdt$/.test(symbol) && ["1m", "5m", "15m", "30m", "60m", "1d"].includes(period))
  activeKeys = new Set(keys.map(keyOf))
  for (const key of streamHeads.keys()) if (!activeKeys.has(key)) streamHeads.delete(key)
  for (const key of retries.keys()) if (!activeKeys.has(key)) retries.delete(key)
  const ws = getMarketWebSocket()
  ws.setChartSubscription(keys)
  const needed = keys.filter(key => {
    const head = streamHeads.get(keyOf(key))
    return !(ws.state === "connected" && head && Date.now() - head.at <= STREAM_STALE_MS) &&
      Date.now() >= (retries.get(keyOf(key))?.after ?? 0)
  })
  const results = await Promise.allSettled(needed.map(({ symbol, period }) => {
    const key = keyOf({ symbol, period })
    const pending = fallbackFlights.get(key)
    if (pending) return pending
    const flight = (async () => {
      try {
        const page = await getKlineApi(symbol, period, { limit: 3 })
        if (activeKeys.has(key)) applyFrames(symbol, period, page.bars)
        retries.delete(key)
      } catch (err) {
        const failures = (retries.get(key)?.failures ?? 0) + 1
        retries.set(key, { failures, after: Date.now() + DELAYS[Math.min(failures - 1, DELAYS.length - 1)] })
        throw err
      } finally { fallbackFlights.delete(key) }
    })()
    fallbackFlights.set(key, flight)
    return flight
  }))
  if (results.length && results.every(result => result.status === "rejected")) throw new Error("OKX 图表行情暂不可用")
}

export function pollOkxFormingOnce(): Promise<void> {
  return pollOnce()
}

function schedule(): void {
  timer = setTimeout(() => {
    schedule()
    void pollOkxFormingOnce().catch(() => { /* Each key has its own retry budget. */ })
  }, POLL_MS)
}

export function startOkxFormingFeed(): void {
  if (typeof window === "undefined" || timer !== null) return
  const ws = getMarketWebSocket()
  unsubscribe = [ws.onMessage(receiveChart), ws.onStateChange(() => { streamHeads.clear(); retries.clear() })]
  schedule()
}

export function stopOkxFormingFeed(): void {
  if (timer !== null) clearTimeout(timer)
  timer = null
  for (const stop of unsubscribe) stop()
  unsubscribe = []
  activeKeys.clear(); streamHeads.clear(); retries.clear()
  getMarketWebSocket().setChartSubscription([])
}

startOkxFormingFeed()
