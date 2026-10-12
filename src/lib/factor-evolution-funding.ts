import type { KlineBar } from "@/types"
import { barTimeToMs } from "./binance-kline"

/** Attach every actual settlement, including all three events inside a daily
 * candle. A forward-filled feature rate alone is not a funding ledger. */
export function attachEvolutionFunding(bars: KlineBar[], events: Array<{t: number; r: number}>) {
  const sorted = [...new Map(events.map(e => [e.t, e])).values()].sort((a, b) => a.t - b.t)
  let cursor = 0
  return bars.map((bar, i) => {
    const start = bar.open_time ?? barTimeToMs(bar.time)
    const next = bars[i + 1]
    const end = next ? next.open_time ?? barTimeToMs(next.time) : start
    while (cursor < sorted.length && sorted[cursor].t < start) cursor++
    const funding_events: Array<{time: number; rate: number}> = []
    while (cursor < sorted.length && sorted[cursor].t < end) {
      const e = sorted[cursor++]
      funding_events.push({time: e.t, rate: e.r})
    }
    return {...bar, funding_events}
  })
}
