import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { MarketWebSocket } from "./websocket"

class Socket {
  static OPEN = 1
  static CONNECTING = 0
  static CLOSED = 3
  static all: Socket[] = []
  readyState = 0
  onopen: (() => void) | null = null
  onmessage = null
  onclose = null
  onerror = null
  send = vi.fn()
  close = vi.fn(() => { this.readyState = 3 })
  constructor() { Socket.all.push(this) }
  open() { this.readyState = 1; this.onopen?.() }
}
let ws: MarketWebSocket
beforeEach(() => {
  vi.useFakeTimers()
  Socket.all = []
  vi.stubGlobal("WebSocket", Socket)
  vi.stubGlobal("window", { location: { protocol: "https:", hostname: "test" } })
  vi.stubGlobal("localStorage", { getItem: () => "session" })
  ws = new MarketWebSocket()
})
afterEach(() => { ws.disconnect(); vi.useRealTimers(); vi.unstubAllGlobals() })

it("sends bounded deduplicated chart keys and restores them after reconnect", () => {
  ws.setChartSubscription([{ symbol: " BTCUSDT ", period: "1m" }, { symbol: "btcusdt", period: "1m" }])
  ws.connect()
  Socket.all[0].open()
  const expected = { action: "subscribe_chart", keys: [{ symbol: "btcusdt", period: "1m" }] }
  expect(JSON.parse(Socket.all[0].send.mock.calls[0][0])).toEqual(expected)
  ws.setChartSubscription([{ symbol: "btcusdt", period: "1m" }])
  expect(Socket.all[0].send).toHaveBeenCalledTimes(1)
  ws.disconnect()
  ws.connect()
  Socket.all[1].open()
  expect(JSON.parse(Socket.all[1].send.mock.calls[0][0])).toEqual(expected)
  ws.setChartSubscription([])
  expect(JSON.parse(Socket.all[1].send.mock.calls[1][0])).toEqual({ action: "subscribe_chart", keys: [] })
})

it("actually clears the legacy subscription when the last consumer leaves", () => {
  ws.connect()
  Socket.all[0].open()
  ws.setKlineSubscription(["btcusdt"])
  ws.setKlineSubscription([])
  expect(JSON.parse(Socket.all[0].send.mock.calls.at(-1)![0])).toEqual({ action: "unsubscribe_kline" })
})

it("restores per-symbol quote exclusions after reconnect without disabling business events", () => {
  ws.setQuoteExclusions([" ADAUSDT ", "adausdt", "../invalid"])
  ws.connect(); Socket.all[0].open()
  expect(Socket.all[0].send).toHaveBeenCalledWith(JSON.stringify({ action: "set_quote_exclusions", symbols: ["adausdt"] }))
  ws.setQuoteExclusions(["adausdt"])
  expect(Socket.all[0].send).toHaveBeenCalledTimes(1)
  ws.disconnect(); ws.connect(); Socket.all[1].open()
  expect(Socket.all[1].send).toHaveBeenCalledWith(JSON.stringify({ action: "set_quote_exclusions", symbols: ["adausdt"] }))
  ws.setQuoteExclusions([])
  expect(Socket.all[1].send).toHaveBeenLastCalledWith(JSON.stringify({ action: "set_quote_exclusions", symbols: [] }))
})
