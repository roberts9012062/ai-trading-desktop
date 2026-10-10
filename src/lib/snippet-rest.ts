import { ensureDesktopRouting, isServerMode } from "./desktop-routing"
import { decodeOkxCandle, decodeOkxTicker } from "./okx-snippet-ws"
import type { KlineResponse } from "./api"
import { snippetOrigin, snippetFailed, snippetSucceeded } from "./snippet-pool"

const periods: Record<string, string> = { "1m":"1m", "5m":"5m", "15m":"15m", "30m":"30m", "60m":"1H", "240m":"4H", "1d":"1D" }
let retryAt = 0
const flights = new Map<string, Promise<unknown>>()
const cache = new Map<string, { until: number; data: unknown }>()
export function resetSnippetRest(): void { retryAt = 0; cache.clear() }

export async function snippetPublicGet(path: string, timeoutMs = 6000): Promise<unknown[]> {
  if (Date.now() < retryAt) throw new Error("Snippet 冷却中")
  const origin = snippetOrigin("rest"), started = Date.now()
  let response: Response
  try { response = await fetch(origin + path, { signal: AbortSignal.timeout(timeoutMs), cache: "no-store", redirect: "error" }) }
  catch (error) { await snippetFailed("rest", origin); throw error }
  let payload
  try { payload = await response.json() }
  catch (error) { await snippetFailed("rest", origin); throw error }
  if (!response.ok || payload.code !== "0" || !Array.isArray(payload.data)) {
    retryAt = Date.now() + (response.status === 429 || payload.code === "50011" ? 60000 : 15000)
    await snippetFailed("rest", origin, response.status === 429 || payload.code === "50011")
    throw new Error("Snippet 行情暂不可用")
  }
  snippetSucceeded("rest", origin, Date.now() - started)
  return payload.data
}

export async function withSnippetRead<T>(key: string, load: () => Promise<T>, fallback: () => Promise<T>, ttl = 2000): Promise<T> {
  await ensureDesktopRouting()
  if (isServerMode() || Date.now() < retryAt) return fallback()
  const cached = cache.get(key)
  if (cached && cached.until > Date.now()) return structuredClone(cached.data) as T
  const existing = flights.get(key)
  if (existing) return structuredClone(await existing) as T
  const flight = (async () => {
    try {
      const data = await load()
      cache.set(key, { until: Date.now() + ttl, data })
      if (cache.size > 128) cache.delete(cache.keys().next().value!)
      return data
    } catch {
      retryAt = Math.max(retryAt, Date.now() + 15000)
      return fallback()
    } finally { flights.delete(key) }
  })()
  flights.set(key, flight)
  return structuredClone(await flight)
}

export async function snippetQuotes(): Promise<Array<Record<string, unknown>>> {
  const rows = await snippetPublicGet("/api/v5/market/tickers?instType=SWAP")
  const decoded = rows.map(decodeOkxTicker).filter(item => item !== null)
  if (!decoded.length) throw new Error("Snippet 没有有效行情")
  return decoded as unknown as Array<Record<string, unknown>>
}

export async function snippetKlines(symbol: string, period: string, options?: {limit?: number; endTime?: string}): Promise<KlineResponse> {
  if (!/^[a-z0-9]{1,16}usdt$/.test(symbol) || !periods[period]) throw new Error("不支持的品种或周期")
  const count = options?.limit || 300
  // Large research/bundle loads remain on server; bounded chart pages avoid an
  // expensive partial download before a rate-limited second page is discarded.
  if (count > 300) throw new Error("大页使用服务器缓存")
  const params = new URLSearchParams({ instId: symbol.slice(0,-4).toUpperCase()+"-USDT-SWAP", bar: periods[period], limit: String(Math.min(count, options?.endTime ? 100 : 300)) })
  if (options?.endTime) {
    const cursor = options.endTime.length === 10 ? options.endTime + "T00:00:00" : options.endTime.replace(" ","T")
    const stamp = Date.parse(cursor + (/[zZ]|[+-]\d\d:\d\d$/.test(cursor) ? "" : "+08:00"))
    if (!Number.isFinite(stamp)) throw new Error("无效的历史时间")
    params.set("after", String(stamp))
  }
  const rows = await snippetPublicGet(`/api/v5/market/${options?.endTime ? "history-candles" : "candles"}?${params}`)
  const bars = rows.map(raw => decodeOkxCandle(raw, period, Date.now())).filter(bar => bar !== null)
  if (bars.length !== rows.length) throw new Error("K线字段校验失败")
  bars.sort((a,b) => a.time.localeCompare(b.time))
  if (new Set(bars.map(b => b.time)).size !== bars.length) throw new Error("K线时间重复")
  if (options?.endTime && bars.some(b => b.time >= options.endTime!)) throw new Error("历史分页游标未推进")
  return { symbol, period, bars: bars.map(bar => ({...bar, market_source:'okx' as const, settle:null,open_interest:null})), has_more: rows.length === Number(params.get("limit")) }
}
