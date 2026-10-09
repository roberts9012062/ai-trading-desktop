import type { KlineBar, KlinePeriod } from "@/types"
import { readRtTail, rtAccKey, mergeTailWithHistory, detectTailGap } from "@/components/market/kline/realtime/accumulator"
import { getOkxSnippetWebSocket } from "./okx-snippet-ws"
import { useMarketStore } from "@/stores/market"
import "./okx-forming"

/** Refresh on this chart's candle frames; the timer only maintains subscriptions/recovery. */
export function watchDisplayCandles(symbol: string, period: KlinePeriod, refresh: () => Promise<void>): () => void {
  const key = symbol.trim().toLowerCase()
  let alive = true, busy = false, queued = false
  const run = async (): Promise<void> => {
    if (!alive) return
    if (busy) { queued = true; return }
    busy = true
    try { await refresh() }
    finally {
      busy = false
      // A frame arriving during the initial history request must not be lost.
      if (alive && queued) { queued = false; void run() }
    }
  }
  const stop = useMarketStore.subscribe((state, previous) => {
    if (state.klineRealtime[key]?.[period] !== previous.klineRealtime[key]?.[period]) void run()
  })
  void run()
  const timer = setInterval(() => void run(), 3000)
  return () => { alive = false; queued = false; clearInterval(timer); stop() }
}

/** Display-only charts share the same stream; task-scoped history stays on server. */
export async function readDisplayCandles(symbol: string, period: KlinePeriod, bars: KlineBar[], loadHistory: () => Promise<KlineBar[]>): Promise<KlineBar[]> {
  const socket = getOkxSnippetWebSocket(), key = rtAccKey(symbol, period)
  const lastTime = bars.at(-1)?.time ?? ""
  const tail = readRtTail(key, lastTime)
  if (bars.length && socket.hasFreshCandle(symbol, period) && !detectTailGap(period, lastTime, tail)) {
    return mergeTailWithHistory(bars, tail, period)?.mergedBars ?? bars
  }
  const history = await loadHistory()
  for (const bar of history) socket.observeVersion(bar.version)
  if (!history.length || !socket.hasFreshCandle(symbol, period)) return history
  return mergeTailWithHistory(history, readRtTail(key, history.at(-1)!.time), period)?.mergedBars ?? history
}
