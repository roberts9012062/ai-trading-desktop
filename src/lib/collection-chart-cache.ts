import type { KlineBar } from '@/types'
import { collectionKlines, collectionSymbol } from './collection-api'
import { COLLECTION_BASE, collectionGeneration, collectionScope, loadCollectionConfig } from './collection-config'
import { openDb, idbGet, idbPut, KLINE_HISTORY_STORE } from './idb'

const THREE_DAYS = 3 * 86400000
const intervals: Record<string, number> = { '1m': 60000, '5m': 300000, '15m': 900000, '30m': 1800000, '60m': 3600000, '240m': 14400000, '1d': 86400000 }
type Page = Awaited<ReturnType<typeof collectionKlines>>
interface Entry { key: string; schema: 1; symbol: string; period: string; bars: KlineBar[]; historyStart?: number; savedAt: number }
const flights = new Map<string, Promise<Page>>()

function entryKey(symbol: string, period: string): string {
  return `collection-chart-v1:${COLLECTION_BASE}:okx:${collectionSymbol(symbol)}:${period}`
}

/** Keep an already opened chart's cache moving while the application stays
 * open. A read/write transaction prevents concurrent closed frames losing one
 * another; replayed identical frames do not cause repeated disk writes. */
export async function cacheCollectionCandle(symbol: string, period: string, bar: KlineBar): Promise<void> {
  try {
    const step = intervals[period], offset = period === '1d' ? 28800000 : 0
    if (!step || bar.is_closed !== true) return
    const current = Math.floor((Date.now() + offset) / step) * step - offset
    if (!valid(bar, period, step, current)) return
    const key = entryKey(symbol, period)
    if ([...flights.keys()].some(flight => flight.includes(key + ':'))) return
    const db = await openDb()
    if (!db) return
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(KLINE_HISTORY_STORE, 'readwrite'), store = tx.objectStore(KLINE_HISTORY_STORE)
      const request = store.get(key)
      request.onsuccess = () => {
        const saved = request.result as Entry | undefined
        if (saved?.schema !== 1 || !Array.isArray(saved.bars)) return
        const previous = saved.bars.find(b => b?.open_time === bar.open_time)
        if (previous?.is_closed === true && ['open', 'high', 'low', 'close', 'volume', 'quote_volume'].every(field => previous[field as keyof KlineBar] === bar[field as keyof KlineBar])) return
        const bars = new Map(saved.bars.filter(b => valid(b, period, step, current)).map(b => [b.open_time!, b]))
        bars.set(bar.open_time!, bar)
        const latest = Math.max(...bars.keys()), count = Math.max(240, Math.ceil(THREE_DAYS / step) + 1, Math.min(5000, saved.bars.length))
        const start = latest - (count - 1) * step
        store.put({ ...saved, savedAt: Date.now(), bars: [...bars.values()].filter(b => b.open_time! >= start).sort((a, b) => a.open_time! - b.open_time!) })
      }
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error)
    })
  } catch { /* Local cache failure must not interrupt realtime delivery. */ }
}

function valid(bar: KlineBar, period: string, step: number, latest: number): boolean {
  const t = bar?.open_time
  const offset = period === '1d' ? 28800000 : 0
  if (!Number.isSafeInteger(t) || t! <= 0 || t! > latest || (t! + offset) % step !== 0 || bar.market_source !== 'okx') return false
  const expected = new Date(t! + 28800000).toISOString().replace('T', ' ').slice(0, period === '1d' ? 10 : 19)
  return bar.time === expected && [bar.open, bar.high, bar.low, bar.close, bar.volume].every(Number.isFinite) &&
    Math.min(bar.open, bar.high, bar.low, bar.close) > 0 && bar.volume >= 0 &&
    bar.high >= Math.max(bar.open, bar.close, bar.low) && bar.low <= Math.min(bar.open, bar.close, bar.high)
}

/** Verify rolling local history before exposing it to charts. Only holes and
 * the two most recent candles are fetched; scrolling and realtime probes retain
 * the raw API's bounded-page behavior. No key or ticket is persisted. */
export async function collectionChartKlines(symbol: string, period: string, options?: { limit?: number; endTime?: string }): Promise<Page> {
  const limit = options?.limit ?? 300, step = intervals[period]
  if (!step || options?.endTime || limit <= 3 || !Number.isInteger(limit) || limit > 5000) return collectionKlines(symbol, period, options)
  await loadCollectionConfig()
  const generation = collectionGeneration(), scope = collectionScope()
  const key = entryKey(symbol, period)
  const flightKey = `${scope}:${generation}:${key}:${limit}`
  const pending = flights.get(flightKey)
  if (pending) return pending
  const unchanged = () => { if (generation !== collectionGeneration() || scope !== collectionScope()) throw new Error('行情配置已变化，已取消旧请求') }
  const verify = async (catchups: number): Promise<Page> => {
    const db = await openDb()
    const saved = db ? await idbGet<Entry>(db, KLINE_HISTORY_STORE, key).catch(() => undefined) : undefined
    unchanged()
    const tail = await collectionKlines(symbol, period, { limit: 2 })
    unchanged()
    const now = Date.now(), offset = period === '1d' ? 28800000 : 0
    const current = Math.floor((now + offset) / step) * step - offset
    if (!tail.bars.length) throw new Error('最新 K 线暂不可用，请稍后重试')
    if (tail.bars.some(b => !valid(b, period, step, current))) throw new Error('最新 K 线校验失败，请重试')
    const latest = Math.max(...tail.bars.map(b => b.open_time!))
    if (now - latest > step + 15000) throw new Error('最新 K 线已过期，请稍后重试')
    const count = Math.max(240, limit, Math.ceil(THREE_DAYS / step) + 1)
    let start = latest - (count - 1) * step
    // Saved coverage metadata is only a hint: it must never conceal damaged
    // or absent bars. Reconfirm an exhausted listing with this entry's reads.
    let historyStart: number | undefined
    const bars = new Map<number, KlineBar>()
    if (saved?.schema === 1 && Array.isArray(saved.bars)) {
      for (const b of saved.bars) if (valid(b, period, step, latest) && b.open_time! >= start && b.is_closed === true) bars.set(b.open_time!, b)
    }
    for (const b of tail.bars) if (b.open_time! >= start) bars.set(b.open_time!, b)
    for (;;) {
      unchanged()
      let end = latest
      while (end >= start && bars.has(end)) end -= step
      if (end < start) break
      let first = end
      while (first - step >= start && !bars.has(first - step) && (end - first) / step < 499) first -= step
      const requested = (end - first) / step + 1
      // Raw endTime subtracts one second and OKX `after` excludes its exact
      // timestamp. Two seconds keeps this desired last candle inside the page.
      const page = await collectionKlines(symbol, period, { limit: requested, endTime: new Date(end + 2000).toISOString() })
      unchanged()
      if (page.bars.some(b => !valid(b, period, step, latest) || b.open_time! > end)) throw new Error('补充 K 线校验失败，请重试')
      let added = 0
      for (const b of page.bars) if (b.open_time! >= start && b.open_time! >= first && !bars.has(b.open_time!)) { bars.set(b.open_time!, b); added++ }
      // A short listed history may end before the requested window. Only a
      // leading absent range is allowed; an interior gap fails closed.
      if (!page.has_more && page.bars.length < requested) {
        const oldest = Math.min(...bars.keys())
        const onlyLeading = end < oldest || page.bars.length > 0 && first === start && oldest >= first
        if (onlyLeading) { historyStart = oldest; start = oldest }
      }
      if (!added && end >= start) throw new Error('K 线缺口尚未补齐，请稍后重试')
      // Checkpoint only genuine online candles. A subsequent entry still scans
      // every slot before drawing, so interrupted downloads can safely resume.
      if (db) await idbPut(db, KLINE_HISTORY_STORE, { key, schema: 1, symbol, period, bars: [...bars.values()], historyStart, savedAt: Date.now() } satisfies Entry).catch(() => {})
    }
    const verified = [...bars.values()].filter(b => b.open_time! >= start).sort((a, b) => a.open_time! - b.open_time!)
    unchanged()
    if (db) await idbPut(db, KLINE_HISTORY_STORE, { key, schema: 1, symbol, period, bars: verified, historyStart, savedAt: Date.now() } satisfies Entry).catch(() => {
      // Disk failure must not invalidate freshly verified online data.
    })
    unchanged()
    if (Date.now() - latest > step + 15000) {
      if (catchups >= 1) throw new Error('最新 K 线仍在同步，请重新核对')
      return verify(catchups + 1)
    }
    return { symbol, period, bars: verified as Page['bars'], has_more: historyStart === undefined || verified[0]?.open_time! > historyStart }
  }
  const task = verify(0)
  flights.set(flightKey, task)
  try { return await task } finally { if (flights.get(flightKey) === task) flights.delete(flightKey) }
}
