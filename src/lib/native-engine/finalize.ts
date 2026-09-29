import type { Champion, PortfolioResult, SearchResult } from "@/lib/factor-lab-api"
import type { LocalFactorPayload } from "@/lib/local-factor"
import type { KlineBar } from "@/types"
import { isCurrentNativeMetrics } from "./version"

/** Native output must never pass through the Pyodide version-stamping path. */
export function finalizeNativeSearch(payload: LocalFactorPayload, bars: KlineBar[], champions: Champion[], portfolio: PortfolioResult | null): SearchResult {
  for (const row of champions) {
    if (!isCurrentNativeMetrics(row.metrics as unknown as Record<string, unknown>)) throw new Error("原生冠军版本不匹配，禁止混用旧口径")
  }
  return { symbol: payload.symbol, timeframe: payload.timeframe, bars: bars.length,
    range: { from: bars[0]?.time ?? null, to: bars.at(-1)?.time ?? null }, champions, portfolio, coach_note: null } as SearchResult
}
