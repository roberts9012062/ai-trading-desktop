import type { MarketDepthField, MarketDepthStats } from "@/types"
import type { QuoteData } from "@/lib/websocket"

/** OKX ticker fields are rolling 24-hour values; unavailable futures fields are never reused. */
export function cryptoDepthStats(quote: QuoteData | undefined, spread: number | null): MarketDepthStats {
  const field = (value: number | undefined | null, positive = false): MarketDepthField =>
    value != null && Number.isFinite(value) && (!positive || value > 0)
      ? { value, source: quote?.source ?? quote?.exchange ?? "quote", quality: "direct" }
      : { value: null, source: "missing", quality: "missing" }
  const open = quote?.open_price, high = quote?.high_price, low = quote?.low_price
  const amplitude = open && high && low && open > 0 && high >= low ? (high - low) / open * 100 : null
  return {
    last: field(quote?.last_price, true), open: field(open, true),
    high: field(high, true), low: field(low, true),
    change: field(quote?.change), change_pct: field(quote?.change_pct),
    volume: field(quote?.volume), amplitude: { ...field(amplitude), quality: amplitude == null ? "missing" : "derived" },
    spread: field(spread), spread_pct: { ...field(spread != null && quote?.last_price ? spread / quote.last_price * 100 : null), quality: "derived" },
  }
}

export function formatCoinQuantity(value: number | undefined): string {
  return value != null && Number.isFinite(value) && value >= 0
    ? value.toLocaleString("zh-CN", { maximumFractionDigits: 8 }) : "--"
}
