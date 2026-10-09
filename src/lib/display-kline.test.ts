import { afterEach, expect, it, vi } from "vitest"
const mock = vi.hoisted(() => ({ tail: vi.fn(), merge: vi.fn(), gap: vi.fn(), fresh: vi.fn(), observe: vi.fn(), subscribe: vi.fn() }))
vi.mock("@/components/market/kline/realtime/accumulator", () => ({ readRtTail: mock.tail, rtAccKey: (s: string, p: string) => `${s}:${p}`, mergeTailWithHistory: mock.merge, detectTailGap: mock.gap }))
vi.mock("./okx-snippet-ws", () => ({ getOkxSnippetWebSocket: () => ({ hasFreshCandle: mock.fresh, observeVersion: mock.observe }) }))
vi.mock("./okx-forming", () => ({}))
vi.mock("@/stores/market", () => ({ useMarketStore: { subscribe: mock.subscribe } }))
import { readDisplayCandles, watchDisplayCandles } from "./display-kline"
afterEach(() => vi.useRealTimers())
const bar = { time: "2026-10-09 17:00:00", open: 1, high: 2, low: 1, close: 2, volume: 10 }
it("uses the direct stream for forecast display without polling server history", async () => {
  mock.fresh.mockReturnValue(true); mock.tail.mockReturnValue([bar]); mock.gap.mockReturnValue(null)
  mock.merge.mockReturnValue({ mergedBars: [bar] })
  const history = vi.fn()
  expect(await readDisplayCandles("adausdt", "15m", [bar], history)).toEqual([bar])
  expect(history).not.toHaveBeenCalled()
})
it("loads initial history and repairs a detected gap", async () => {
  mock.fresh.mockReturnValue(false); mock.tail.mockReturnValue([])
  const history = vi.fn().mockResolvedValue([bar])
  expect(await readDisplayCandles("adausdt", "15m", [], history)).toEqual([bar])
  mock.fresh.mockReturnValue(true); mock.tail.mockReturnValue([bar]); mock.gap.mockReturnValue("gap")
  await readDisplayCandles("adausdt", "15m", [bar], history)
  expect(history).toHaveBeenCalledTimes(2)
})

it("refreshes immediately for the selected candle, ignores prices/other charts and cleans up", async () => {
  vi.useFakeTimers()
  const unsubscribe = vi.fn()
  mock.subscribe.mockReturnValue(unsubscribe)
  const refresh = vi.fn().mockResolvedValue(undefined)
  const stop = watchDisplayCandles("ADAUSDT", "15m", refresh)
  await Promise.resolve()
  expect(refresh).toHaveBeenCalledTimes(1)
  const notify = mock.subscribe.mock.lastCall![0]
  const previous = { klineRealtime: { adausdt: { "15m": bar } } }
  notify({ ...previous, quotes: { adausdt: { last_price: 3 } } }, previous)
  notify({ klineRealtime: { ...previous.klineRealtime, btcusdt: { "15m": bar } } }, previous)
  expect(refresh).toHaveBeenCalledTimes(1)
  notify({ klineRealtime: { adausdt: { "15m": { ...bar, close: 1.5 } } } }, previous)
  expect(refresh).toHaveBeenCalledTimes(2) // no timer advance
  await Promise.resolve()
  await vi.advanceTimersByTimeAsync(3000)
  expect(refresh).toHaveBeenCalledTimes(3)
  stop()
  expect(unsubscribe).toHaveBeenCalledOnce()
  await vi.advanceTimersByTimeAsync(6000)
  notify({ klineRealtime: {} }, previous)
  expect(refresh).toHaveBeenCalledTimes(3)
})

it("coalesces frames during slow history and consumes the latest tail as soon as history resolves", async () => {
  vi.useFakeTimers()
  mock.subscribe.mockReturnValue(vi.fn())
  let resolve!: () => void
  const refresh = vi.fn().mockImplementationOnce(() => new Promise<void>(r => { resolve = r })).mockResolvedValue(undefined)
  const stop = watchDisplayCandles("adausdt", "15m", refresh)
  const notify = mock.subscribe.mock.lastCall![0]
  const previous = { klineRealtime: {} }
  for (let close = 1; close <= 3; close++) notify({ klineRealtime: { adausdt: { "15m": { ...bar, close } } } }, previous)
  expect(refresh).toHaveBeenCalledTimes(1)
  resolve()
  await Promise.resolve(); await Promise.resolve()
  expect(refresh).toHaveBeenCalledTimes(2)
  stop()
})

it("does not refresh a removed chart after an in-flight history request completes", async () => {
  vi.useFakeTimers()
  mock.subscribe.mockReturnValue(vi.fn())
  let resolve!: () => void
  const refresh = vi.fn().mockImplementation(() => new Promise<void>(r => { resolve = r }))
  const stop = watchDisplayCandles("adausdt", "15m", refresh)
  mock.subscribe.mock.lastCall![0]({ klineRealtime: { adausdt: { "15m": bar } } }, { klineRealtime: {} })
  stop(); resolve()
  await Promise.resolve(); await Promise.resolve()
  expect(refresh).toHaveBeenCalledOnce()
})
