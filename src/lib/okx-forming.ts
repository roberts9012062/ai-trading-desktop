/** Active charts poll the same cached OKX SWAP candles used by task signals.
 * Historical research downloads remain local. No quotes are converted to bars.
 */
import { getKlineApi } from "@/lib/api"
import { useMarketStore } from "@/stores/market"
import { listActiveRtKeys, offerRtBar } from "@/components/market/kline/realtime/accumulator"
import type { KlinePeriod } from "@/types"

const POLL_MS = 3_000
const IDLE_MS = 30_000
const DELAYS = [POLL_MS, 2 * POLL_MS, 5 * POLL_MS]
let timer: ReturnType<typeof setTimeout> | null = null
let failures = 0

export async function pollOkxFormingOnce(): Promise<void> {
  const keys = listActiveRtKeys(IDLE_MS).filter(({ period }) => period !== "tick")
  const results = await Promise.allSettled(keys.map(async ({ symbol, period }) => {
    const page = await getKlineApi(symbol, period, { limit: 3 })
    for (const bar of page.bars) offerRtBar(symbol, period, bar)
    useMarketStore.getState().updateKlineRealtime(page.bars.map(bar => ({ symbol, period: period as KlinePeriod, bar })))
  }))
  if (results.length && results.every(result => result.status === "rejected")) {
    throw new Error("OKX 图表行情暂不可用")
  }
}

function schedule(): void {
  timer = setTimeout(async () => {
    try {
      await pollOkxFormingOnce()
      failures = 0
    } catch {
      failures++
    } finally {
      schedule()
    }
  }, DELAYS[Math.min(failures, DELAYS.length - 1)])
}

export function startOkxFormingFeed(): void {
  if (typeof window !== "undefined" && !timer) schedule()
}

startOkxFormingFeed()
