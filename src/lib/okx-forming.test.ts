import { afterEach, beforeEach, expect, it, vi } from "vitest"
import type { WsMessage, ConnectionState } from "./websocket"

const mock = vi.hoisted(() => ({
  read: vi.fn(), active: vi.fn(), offer: vi.fn(), update: vi.fn(), subscribe: vi.fn(),
  message: null as ((m: WsMessage) => void) | null,
  stateHandler: null as ((s: ConnectionState) => void) | null,
  state: "connected" as ConnectionState,
  observe: vi.fn(), connection: vi.fn(),
}))
vi.mock("./api", () => ({ getKlineApi: mock.read }))
vi.mock("@/stores/market", () => ({ useMarketStore: { getState: () => ({ updateKlineRealtime: mock.update, setConnectionState: mock.connection }) } }))
vi.mock("@/components/market/kline/realtime/accumulator", () => ({ listActiveRtKeys: mock.active, offerRtBar: mock.offer }))
vi.mock("./websocket", () => ({ getMarketWebSocket: () => ({ setChartSubscription: vi.fn(), onMessage: () => () => {}, onStateChange: () => () => {} }) }))
vi.mock('./desktop-routing', () => ({ isServerMode: () => false }))
vi.mock("./okx-snippet-ws", () => ({ OKX_SNIPPET_CANDLE_STALE_MS: 15000, getOkxSnippetWebSocket: () => ({
  get state() { return mock.state }, setChartSubscription: mock.subscribe,
  observeVersion: mock.observe,
  onMessage: (h: (m: WsMessage) => void) => { mock.message = h; return () => { mock.message = null } },
  onStateChange: (h: (s: ConnectionState) => void) => { mock.stateHandler = h; return () => { mock.stateHandler = null } },
}) }))

const key = { symbol: "btcusdt", period: "1m" }
const other = { symbol: "ethusdt", period: "5m" }
const bar = { time: "2026-10-05 16:00:00", open: 100, high: 102, low: 99, close: 101,
  volume: 3, market_source: "okx", version: 100, kind: "correction", is_closed: true }
let feed: typeof import("./okx-forming")
beforeEach(async () => {
  vi.resetModules(); vi.useFakeTimers(); vi.clearAllMocks()
  vi.stubGlobal("window", {})
  mock.state = "connected"
  mock.active.mockReturnValue([key])
  mock.read.mockResolvedValue({ bars: [bar] })
  feed = await import("./okx-forming")
})
afterEach(() => { feed.stopOkxFormingFeed(); vi.useRealTimers(); vi.unstubAllGlobals() })

it("stops duplicate REST only for keys with valid official stream delivery", async () => {
  await feed.pollOkxFormingOnce()
  mock.read.mockClear(); mock.update.mockClear(); mock.offer.mockClear()
  mock.message!({ type: "chart_kline", data: [{ ...key, bar }] })
  expect(mock.offer).toHaveBeenCalledWith(key.symbol, key.period, bar)
  expect(mock.update).toHaveBeenCalledWith([{ ...key, bar }])
  await feed.pollOkxFormingOnce()
  expect(mock.read).not.toHaveBeenCalled()
  mock.active.mockReturnValue([key, other])
  await feed.pollOkxFormingOnce()
  expect(mock.read).toHaveBeenCalledExactlyOnceWith(other.symbol, other.period, { limit: 3 })
})

it("restores REST after stale delivery, disconnect or old-server messages", async () => {
  await feed.pollOkxFormingOnce()
  mock.message!({ type: "chart_kline", data: [{ ...key, bar }] })
  mock.read.mockClear()
  vi.setSystemTime(Date.now() + 16000)
  await feed.pollOkxFormingOnce()
  expect(mock.read).toHaveBeenCalledTimes(1)
  mock.message!({ type: "chart_kline", data: [{ ...key, bar: { ...bar, version: 101 } }] })
  mock.state = "reconnecting"; mock.stateHandler!("reconnecting")
  mock.read.mockClear()
  await feed.pollOkxFormingOnce()
  expect(mock.read).toHaveBeenCalledTimes(1)
  mock.message!({ type: "kline", data: [{ ...key, bar }] })
  mock.read.mockClear()
  await feed.pollOkxFormingOnce()
  expect(mock.read).toHaveBeenCalledTimes(1)
})

it("rejects foreign, malformed, unsolicited and older-version candles without suppressing fallback", async () => {
  await feed.pollOkxFormingOnce()
  mock.offer.mockClear(); mock.update.mockClear()
  for (const frame of [{ ...key, bar: { ...bar, market_source: "gate" } },
    { ...key, bar: { ...bar, high: 98 } }, { ...key, bar: { ...bar, version: undefined } },
    { ...other, bar }]) mock.message!({ type: "chart_kline", data: [frame] })
  expect(mock.offer).not.toHaveBeenCalled()
  mock.read.mockClear()
  await feed.pollOkxFormingOnce()
  expect(mock.read).toHaveBeenCalledTimes(1)
  mock.message!({ type: "chart_kline", data: [{ ...key, bar: { ...bar, version: 200 } }] })
  vi.setSystemTime(Date.now() + 16000)
  mock.offer.mockClear()
  mock.message!({ type: "chart_kline", data: [{ ...key, bar: { ...bar, version: 199 } }] })
  expect(mock.offer).not.toHaveBeenCalled()
  mock.read.mockClear()
  await feed.pollOkxFormingOnce()
  expect(mock.read).toHaveBeenCalledTimes(1)
})

it("shares overlapping poll cycles and clears subscriptions when no consumers remain", async () => {
  let resolve!: (v: { bars: typeof bar[] }) => void
  mock.read.mockReturnValue(new Promise(r => { resolve = r }))
  const a = feed.pollOkxFormingOnce(), b = feed.pollOkxFormingOnce()
  expect(mock.read).toHaveBeenCalledTimes(1)
  resolve({ bars: [bar] })
  await Promise.all([a, b])
  mock.active.mockReturnValue([])
  await feed.pollOkxFormingOnce()
  expect(mock.subscribe).toHaveBeenLastCalledWith([])
})

it("a slow REST key does not delay subscribing or updating a newly opened chart", async () => {
  let resolve!: (v: { bars: typeof bar[] }) => void
  mock.read.mockImplementation((symbol: string) => symbol === key.symbol
    ? new Promise(r => { resolve = r }) : Promise.resolve({ bars: [bar] }))
  const pending = feed.pollOkxFormingOnce()
  mock.active.mockReturnValue([key, other])
  const next = feed.pollOkxFormingOnce()
  expect(mock.subscribe).toHaveBeenLastCalledWith([key, other])
  await Promise.resolve(); await Promise.resolve()
  expect(mock.offer).toHaveBeenCalledWith(other.symbol, other.period, bar)
  expect(mock.read).toHaveBeenCalledTimes(2)
  resolve({ bars: [bar] })
  await Promise.all([pending, next])
})

it("one failing REST key does not apply backoff to another key", async () => {
  mock.active.mockReturnValue([key, other])
  mock.read.mockImplementation((symbol: string) => symbol === key.symbol
    ? Promise.reject(new Error("upstream unavailable")) : Promise.resolve({ bars: [bar] }))
  await feed.pollOkxFormingOnce()
  mock.read.mockClear()
  await feed.pollOkxFormingOnce()
  expect(mock.read).toHaveBeenCalledExactlyOnceWith(other.symbol, other.period, { limit: 3 })
})

it("does not overwrite newer direct candles with a late server recovery response", async () => {
  let resolve!: (v: { bars: typeof bar[] }) => void
  mock.read.mockReturnValue(new Promise(r => { resolve = r }))
  const pending = feed.pollOkxFormingOnce()
  mock.message!({ type: "chart_kline", data: [{ ...key, bar: { ...bar, close: 102, version: 200 } }] })
  mock.offer.mockClear()
  resolve({ bars: [bar] }); await pending
  expect(mock.offer).not.toHaveBeenCalled()
  expect(mock.observe).toHaveBeenCalledWith(bar.version)
})
