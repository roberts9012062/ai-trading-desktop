import { expect, it, vi } from "vitest"
import type { WsMessage } from "@/lib/websocket"
const mock = vi.hoisted(() => ({ server: null as ((message: WsMessage) => void) | null,
  direct: null as ((message: WsMessage) => void) | null, freshness: null as ((symbols: string[]) => void) | null,
  fresh: new Set<string>(), exclusions: vi.fn(), snapshot: vi.fn(), connect: vi.fn(), charts: vi.fn() }))
vi.mock("@/lib/websocket", () => ({ getMarketWebSocket: () => ({ connect: vi.fn(), setChartSubscription: mock.charts,
  setMarketFallback: vi.fn(), setQuoteExclusions: mock.exclusions, onMessage: (handler: (message: WsMessage) => void) => { mock.server = handler }, setKlineSubscription: vi.fn() }) }))
vi.mock('@/lib/desktop-routing', () => ({ ensureDesktopRouting: async () => {}, isServerMode: () => false, onDesktopRoutingChange: vi.fn() }))
vi.mock("@/lib/okx-snippet-ws", () => ({ getOkxSnippetWebSocket: () => ({ connect: mock.connect, setQuoteSymbols: vi.fn(),
  setDepthSymbols: vi.fn(), hasFreshDepth: () => false,
  hasFreshQuote: (symbol: string) => mock.fresh.has(symbol),
  onMessage: (handler: (message: WsMessage) => void) => { mock.direct = handler },
  onQuoteFreshnessChange: (handler: (symbols: string[]) => void) => { mock.freshness = handler } }) }))
vi.mock("@/lib/api", () => ({ getQuotesSnapshotApi: mock.snapshot, getContractsByCodeApi: vi.fn() }))
import { useMarketStore } from "./market"
import { useNotificationsStore } from "./notifications"

it("keeps direct prices over late server snapshots, preserves fallback coins and notifications", async () => {
  let resolve!: (value: unknown) => void
  mock.snapshot.mockReturnValue(new Promise(r => { resolve = r }))
  useMarketStore.getState().initWebSocket()
  mock.fresh.add("adausdt")
  mock.direct!({ type: "quote", data: [{ symbol: "adausdt", last_price: 2, decimal_places: 4 }] })
  mock.server!({ type: "quote", data: [{ symbol: "adausdt", last_price: 1 }, { symbol: "vetusdt", last_price: .5 }] })
  resolve([{ symbol: "adausdt", last_price: .8 }])
  await Promise.resolve(); await Promise.resolve()
  expect(useMarketStore.getState().quotes.adausdt.last_price).toBe(2)
  expect(useMarketStore.getState().quotes.vetusdt.last_price).toBe(.5)
  mock.freshness!(["adausdt"])
  expect(mock.exclusions).toHaveBeenLastCalledWith(["adausdt"])
  mock.fresh.clear(); mock.freshness!([])
  mock.server!({ type: "quote", data: [{ symbol: "adausdt", last_price: 3 }] })
  expect(useMarketStore.getState().quotes.adausdt.last_price).toBe(3)
  expect(mock.exclusions).toHaveBeenLastCalledWith([])
  mock.server!({ type: "unread_count", data: { unread: 7 } })
  expect(useNotificationsStore.getState().unread).toBe(7)
  expect(mock.charts).toHaveBeenCalledWith([])
})
