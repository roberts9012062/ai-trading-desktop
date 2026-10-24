import 'fake-indexeddb/auto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { KlineBar } from '@/types'
const fixture = vi.hoisted(() => ({
  now: Date.parse('2026-10-24T04:30:20Z'), generation: 0, scope: 'user-a',
  fetch: vi.fn(), rows: [] as KlineBar[],
}))
vi.mock('./collection-config', () => ({
  COLLECTION_BASE: 'https://lium.eu.org',
  collectionMode: () => true, collectionScope: () => fixture.scope,
  collectionGeneration: () => fixture.generation, loadCollectionConfig: async () => ({ configured: true }),
  nativeCollection: () => false,
}))
vi.mock('./collection-api', () => ({
  collectionKlines: fixture.fetch,
  collectionSymbol: (s: string) => s.toLowerCase().replace('usdt', '-USDT-SWAP').toUpperCase(),
}))
import { verifyCollectionChartKlines as getKlineApi } from './collection-chart-cache'
import { cacheCollectionCandle } from './collection-chart-cache'
import { openDb, KLINE_HISTORY_STORE, idbGetAll, idbPut } from './idb'

function bar(time: number, period = '1m'): KlineBar {
  return { open_time: time, time: new Date(time + 28800000).toISOString().replace('T', ' ').slice(0, period === '1d' ? 10 : 19),
    open: 100, high: 102, low: 99, close: 101, volume: 1, market_source: 'okx', is_closed: true }
}
async function entry() {
  return (await idbGetAll<{ key: string; bars: KlineBar[] }>((await openDb())!, KLINE_HISTORY_STORE))[0]
}
beforeEach(async () => {
  vi.spyOn(Date, 'now').mockImplementation(() => fixture.now)
  fixture.now = Date.parse('2026-10-24T04:30:20Z'); fixture.generation = 0; fixture.scope = 'user-a'
  fixture.rows = Array.from({ length: 6000 }, (_, i) => bar(Math.floor(fixture.now / 60000) * 60000 - i * 60000))
  fixture.fetch.mockReset().mockImplementation(async (symbol, period, options) => {
    const end = options?.endTime ? Date.parse(options.endTime) - 1000 : Infinity
    // Collection converts endTime to seconds minus one; OKX's `after` is
    // exclusive. Preserve that real boundary instead of an inclusive fixture.
    const rows = fixture.rows.filter(b => b.open_time! < end).slice(0, options?.limit ?? 300).reverse()
    return { symbol, period, bars: rows, has_more: rows.length === (options?.limit ?? 300) }
  })
  const db = (await openDb())!
  await new Promise<void>(resolve => { const tx = db.transaction(KLINE_HISTORY_STORE, 'readwrite'); tx.objectStore(KLINE_HISTORY_STORE).clear(); tx.oncomplete = () => resolve() })
})
afterEach(() => vi.restoreAllMocks())

it('persists three full days of minute candles before returning verified chart history', async () => {
  const result = await getKlineApi('btcusdt', '1m', { limit: 240 })
  expect(result.bars).toHaveLength(4321)
  expect((await entry()).bars).toHaveLength(4321)
  expect(fixture.fetch.mock.calls.every(([, , options]) => options.limit <= 500)).toBe(true)
})

it('reuses persisted history after module restart and refreshes only the latest two candles', async () => {
  await getKlineApi('btcusdt', '1m', { limit: 240 })
  fixture.fetch.mockClear(); vi.resetModules()
  const { verifyCollectionChartKlines: restarted } = await import('./collection-chart-cache')
  const result = await restarted('btcusdt', '1m', { limit: 240 })
  expect(result.bars).toHaveLength(4321)
  expect(fixture.fetch.mock.calls.map(([, , options]) => options.limit)).toEqual([2])
})

it('repairs an interior gap and corrupt candle, removes duplicates, and preserves the rest', async () => {
  await getKlineApi('btcusdt', '1m', { limit: 240 })
  const saved = await entry(), original = saved.bars[100]
  saved.bars.splice(100, 1); saved.bars[200].high = 1; saved.bars.push(saved.bars[300])
  await idbPut((await openDb())!, KLINE_HISTORY_STORE, saved)
  fixture.fetch.mockClear()
  const result = await getKlineApi('btcusdt', '1m', { limit: 240 })
  expect(result.bars).toHaveLength(4321)
  expect(result.bars[100]).toMatchObject(original)
  expect(result.bars[201].high).toBe(102)
  expect(fixture.fetch.mock.calls.map(([, , options]) => options.limit)).toEqual([2, 1, 1])
})

it('fills only the missing tail after an hour away and trims the rolling window', async () => {
  await getKlineApi('btcusdt', '1m', { limit: 240 })
  fixture.now += 3600000
  fixture.rows.unshift(...Array.from({ length: 60 }, (_, i) => bar(Math.floor(fixture.now / 60000) * 60000 - i * 60000)))
  fixture.fetch.mockClear()
  const result = await getKlineApi('btcusdt', '1m', { limit: 240 })
  expect(result.bars).toHaveLength(4321)
  expect(fixture.fetch.mock.calls.map(([, , options]) => options.limit)).toEqual([2, 58])
  expect((await entry()).bars[0].open_time).toBe(Math.floor(fixture.now / 60000) * 60000 - 3 * 86400000)
})

it('never returns or overwrites a validated cache if verification cannot fill a gap', async () => {
  await getKlineApi('btcusdt', '1m', { limit: 240 })
  const saved = await entry(); saved.bars.splice(100, 1)
  await idbPut((await openDb())!, KLINE_HISTORY_STORE, saved)
  fixture.fetch.mockImplementationOnce(async () => ({ symbol: 'btcusdt', period: '1m', bars: fixture.rows.slice(0, 2).reverse(), has_more: true }))
    .mockRejectedValueOnce(new Error('network unavailable'))
  await expect(getKlineApi('btcusdt', '1m', { limit: 240 })).rejects.toThrow('network unavailable')
  expect((await entry()).bars).toHaveLength(4320)
})

it('shares concurrent verification and rejects stale account results without writing them', async () => {
  const [a, b] = await Promise.all([getKlineApi('btcusdt', '1m', { limit: 240 }), getKlineApi('btcusdt', '1m', { limit: 240 })])
  expect(a).toEqual(b)
  expect(fixture.fetch.mock.calls.filter(([, , options]) => !options.endTime)).toHaveLength(1)
  fixture.fetch.mockImplementationOnce(async () => {
    fixture.generation++; return { symbol: 'btcusdt', period: '1m', bars: fixture.rows.slice(0, 2).reverse(), has_more: true }
  })
  await expect(getKlineApi('btcusdt', '1m', { limit: 240 })).rejects.toThrow('配置已变化')
})

it('keeps at least 240 daily candles on the OKX Beijing daily boundary', async () => {
  fixture.rows = Array.from({ length: 300 }, (_, i) => bar(Date.parse('2026-10-23T16:00:00Z') - i * 86400000, '1d'))
  const result = await getKlineApi('btcusdt', '1d', { limit: 240 })
  expect(result.bars).toHaveLength(240)
  expect(result.bars.at(-1)?.time).toBe('2026-10-24')
  expect((await entry()).bars).toHaveLength(240)
})

it('keeps small realtime recovery reads and explicit historical pagination bounded', async () => {
  expect((await getKlineApi('btcusdt', '1m', { limit: 3 })).bars).toHaveLength(3)
  expect((await getKlineApi('btcusdt', '1m', { limit: 240, endTime: '2026-10-24T03:00:00Z' })).bars).toHaveLength(240)
  expect(await entry()).toBeUndefined()
})

it('keeps verified downloaded pages after an interrupted first download and resumes the remaining gap', async () => {
  const real = fixture.fetch.getMockImplementation()!
  fixture.fetch.mockImplementation(async (...args) => {
    if (fixture.fetch.mock.calls.length === 3) throw new Error('interrupted')
    return real(...args)
  })
  await expect(getKlineApi('btcusdt', '1m', { limit: 240 })).rejects.toThrow('interrupted')
  expect((await entry())?.bars).toHaveLength(502)
  fixture.fetch.mockImplementation(real).mockClear()
  const result = await getKlineApi('btcusdt', '1m', { limit: 240 })
  expect(result.bars).toHaveLength(4321)
  expect(fixture.fetch.mock.calls.reduce((n, [, , options]) => n + options.limit, 0)).toBe(3821)
})

it('accepts genuinely short listed history but never invents missing interior candles', async () => {
  fixture.rows = fixture.rows.slice(0, 25)
  expect((await getKlineApi('newusdt', '1m', { limit: 240 })).bars).toHaveLength(25)
  const saved = await entry(); saved.bars.splice(10, 1)
  await idbPut((await openDb())!, KLINE_HISTORY_STORE, saved)
  fixture.rows.splice(14, 1)
  await expect(getKlineApi('newusdt', '1m', { limit: 240 })).rejects.toThrow('缺口尚未补齐')
})

it('does not let corrupted range metadata hide absent older candles', async () => {
  await getKlineApi('btcusdt', '1m', { limit: 240 })
  const saved = await entry()
  Object.assign(saved, { historyStart: fixture.rows[0].open_time })
  saved.bars = saved.bars.slice(-2)
  await idbPut((await openDb())!, KLINE_HISTORY_STORE, saved)
  expect((await getKlineApi('btcusdt', '1m', { limit: 240 })).bars).toHaveLength(4321)
})

it('catches up again if a slow first download crosses a candle boundary', async () => {
  const real = fixture.fetch.getMockImplementation()!
  fixture.fetch.mockImplementation(async (...args) => {
    const response = await real(...args)
    if (fixture.fetch.mock.calls.length === 2) {
      fixture.now += 120000
      fixture.rows.unshift(bar(Math.floor(fixture.now / 60000) * 60000), bar(Math.floor(fixture.now / 60000) * 60000 - 60000))
    }
    return response
  })
  const result = await getKlineApi('btcusdt', '1m', { limit: 240 })
  expect((result.bars.at(-1) as KlineBar)?.open_time).toBe(Math.floor(fixture.now / 60000) * 60000)
  expect(result.bars).toHaveLength(4321)
})

it('persists closed stream candles while the chart stays open and trims the rolling range', async () => {
  await getKlineApi('btcusdt', '1m', { limit: 240 })
  fixture.now += 120000
  const latest = Math.floor(fixture.now / 60000) * 60000
  await cacheCollectionCandle('btcusdt', '1m', bar(latest - 60000))
  await cacheCollectionCandle('btcusdt', '1m', bar(latest))
  const saved = await entry()
  expect(saved.bars).toHaveLength(4321)
  expect(saved.bars.at(-1)?.open_time).toBe(latest)
  expect(saved.bars[0].open_time).toBe(latest - 3 * 86400000)
})

it('does not populate a new cache from forming, malformed or unrelated stream candles', async () => {
  const latest = Math.floor(fixture.now / 60000) * 60000
  await cacheCollectionCandle('btcusdt', '1m', bar(latest))
  expect(await entry()).toBeUndefined()
  await getKlineApi('btcusdt', '1m', { limit: 240 })
  await cacheCollectionCandle('btcusdt', '1m', { ...bar(latest), close: 100, is_closed: false })
  await cacheCollectionCandle('btcusdt', '1m', { ...bar(latest), high: 1 })
  expect((await entry()).bars.at(-1)?.close).toBe(101)
})
