import type { KlineBar, KlinePeriod } from "@/types"
import { readRtTail, rtAccKey, mergeTailWithHistory, detectTailGap } from "@/components/market/kline/realtime/accumulator"
import { getOkxSnippetWebSocket } from "./okx-snippet-ws"
import "./okx-forming"

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
