/** Public market data only. Uses Tauri's native fetch in desktop builds. */
export const GATE_FUTURES = "https://api.gateio.ws/api/v4/futures/usdt"

export function gateResearchRange(timeframe: string, now = new Date()): { start: string; end: string } {
  return { start: new Date(now.getTime() - (timeframe === "1d" ? 120 : 30) * 86400000).toISOString().slice(0, 10), end: now.toISOString().slice(0, 10) }
}

export function cryptoPair(symbol: string): string {
  const s = symbol.trim().toUpperCase().split(":")[0].replace(/-SWAP$/, "").replace(/[-_/]/g, "")
  if (!/^[A-Z0-9]+USDT$/.test(s) || s === "USDT") throw new Error("直连渠道仅支持 USDT 交易对")
  return s.replace(/USDT$/, "_USDT")
}

export async function publicJson<T>(url: string): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 12_000)
  try {
    const response = await fetch(url, { signal: controller.signal })
    if (!response.ok) {
      const body = await response.json().catch(() => null) as { message?: string; msg?: string } | null
      const detail = body?.message ?? body?.msg
      throw new Error(`公共行情接口 HTTP ${response.status}${typeof detail === "string" ? `：${detail.slice(0, 180)}` : ""}`)
    }
    return await response.json() as T
  } catch (e) {
    if (controller.signal.aborted) throw new Error("公共行情直连超时（12秒），请检查网络后重试")
    throw e
  } finally { clearTimeout(timer) }
}

export function optionalNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

export interface BookSnapshot {
  channel: "gate_usdt" | "gate_spot" | "binance_spot"
  symbol: string
  received_at: number
  exchange_at: number | null
  bid: number
  ask: number
  spread_bps: number
  /** Top 20 displayed levels; Gate perpetual sizes are contracts. */
  imbalance: number
  bid_size: number
  ask_size: number
  levels: number
}

export async function fetchBookSnapshot(channel: BookSnapshot["channel"], symbol: string): Promise<BookSnapshot> {
  const pair = cryptoPair(symbol)
  type Level = [string, string] | { p: string; s: string | number }
  const url = channel === "gate_usdt"
    ? `${GATE_FUTURES}/order_book?contract=${pair}&limit=20`
    : channel === "gate_spot"
      ? `https://api.gateio.ws/api/v4/spot/order_book?currency_pair=${pair}&limit=20&with_id=true`
      : `https://data-api.binance.vision/api/v3/depth?symbol=${pair.replace("_", "")}&limit=20`
  const book = await publicJson<{ bids: Level[]; asks: Level[]; current?: number; update?: number }>(url)
  const levels = (rows: Level[]): [number, number][] => rows.map((r) => Array.isArray(r)
    ? [Number(r[0]), Number(r[1])] as [number, number] : [Number(r.p), Number(r.s)] as [number, number])
  if (!Array.isArray(book.bids) || !Array.isArray(book.asks)) throw new Error("盘口返回格式异常")
  const bids = levels(book.bids), asks = levels(book.asks)
  if (!bids.length || !asks.length || [...bids, ...asks].some(([p, s]) => !Number.isFinite(p) || !Number.isFinite(s) || p <= 0 || s < 0)) {
    throw new Error("盘口为空或包含无效档位")
  }
  const bid = Math.max(...bids.map(([p]) => p)), ask = Math.min(...asks.map(([p]) => p))
  const bidSize = bids.reduce((s, r) => s + r[1], 0), askSize = asks.reduce((s, r) => s + r[1], 0)
  if (bid >= ask || bidSize + askSize <= 0) throw new Error("盘口价差或深度异常")
  return {
    channel, symbol: pair, received_at: Date.now(),
    exchange_at: channel === "gate_usdt" && book.update ? book.update * 1000 : null,
    bid, ask, spread_bps: (ask - bid) / ((ask + bid) / 2) * 10_000,
    imbalance: (bidSize - askSize) / (bidSize + askSize), bid_size: bidSize, ask_size: askSize,
    levels: Math.min(bids.length, asks.length),
  }
}
