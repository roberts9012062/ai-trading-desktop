import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { OkxSnippetWebSocket, decodeOkxCandle, decodeOkxTicker } from "./okx-snippet-ws"

class Socket {
  static all: Socket[] = []
  readyState = 0
  onopen: (() => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  send = vi.fn()
  close = vi.fn(() => { this.readyState = 3 })
  constructor(public url: string) { Socket.all.push(this) }
  open() { this.readyState = 1; this.onopen?.() }
  frame(data: unknown) { this.onmessage?.({ data: typeof data === "string" ? data : JSON.stringify(data) }) }
}
const ticker = { instId: "ADA-USDT-SWAP", last: "0.2387", open24h: "0.25", high24h: "0.26", low24h: "0.22", bidPx: "0.2386", askPx: "0.2387", bidSz: "2", askSz: "3", vol24h: "100", volCcy24h: "10000", ts: "1791536400000" }
const row = ["1791536400000", "0.2397", "0.24", "0.2383", "0.2387", "15241.6", "1524160", "363764.456", "0"]
let ws: OkxSnippetWebSocket
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-09T09:00:00Z")); Socket.all = []
  vi.stubGlobal("WebSocket", Socket)
  ws = new OkxSnippetWebSocket()
})
afterEach(() => { ws.disconnect(); vi.useRealTimers(); vi.unstubAllGlobals() })

it("normalizes perpetual prices and base-coin quantities without accepting spot", () => {
  expect(decodeOkxTicker(ticker)).toMatchObject({ symbol: "adausdt", last_price: .2387, volume: 10000, bid_vol: 200, ask_vol: 300 })
  expect(decodeOkxTicker({ ...ticker, instId: "ADA-USDT" })).toBeNull()
  expect(decodeOkxTicker({ ...ticker, last: "NaN" })).toBeNull()
})
it("normalizes candle timezone, confirmation and base-coin volume", () => {
  expect(decodeOkxCandle(row, "15m", 123)).toMatchObject({ time: "2026-10-09 17:00:00", volume: 1524160, market_source: "okx", is_closed: false, version: 123, kind: "correction" })
  expect(decodeOkxCandle([...row.slice(0, 8), "1"], "1d", 124)?.time).toBe("2026-10-09")
  expect(decodeOkxCandle([row[0], "1", ".1", "0.01", "1", "1", "1", "1", "0"], "15m", 1)).toBeNull()
})
it('shares public depth/trade subscriptions and converts contracts only after a known contract value', async()=>{
  const messages=vi.fn();ws.onMessage(messages);ws.setDepthSymbols(['adausdt']);ws.connect()
  await vi.advanceTimersByTimeAsync(2000);const pub=Socket.all[0];pub.open()
  const depth={arg:{channel:'books5',instId:ticker.instId},data:[{asks:[['.24','2']],bids:[['.23','3']],ts:ticker.ts}]}
  pub.frame(depth);expect(messages).not.toHaveBeenCalled()
  pub.frame({arg:{channel:'tickers',instId:ticker.instId},data:[ticker]});pub.frame(depth)
  expect(messages).toHaveBeenCalledWith({type:'orderbook',data:[expect.objectContaining({asks:[{price:.24,volume:200}],bids:[{price:.23,volume:300}]})]})
  pub.frame({arg:{channel:'trades',instId:ticker.instId},data:[{tradeId:'1',px:'.24',sz:'4',ts:ticker.ts,side:'buy'}]})
  expect(messages).toHaveBeenCalledWith({type:'trades',data:{adausdt:[expect.objectContaining({volume:400,source:'realtime'})]}})
  expect(Socket.all).toHaveLength(1)
})
it("shares two credential-free sockets, deduplicates subscriptions and batches quotes", async () => {
  const messages = vi.fn(); ws.onMessage(messages)
  ws.setQuoteSymbols(["adausdt", "ADAUSDT"])
  ws.setChartSubscription([{ symbol: "adausdt", period: "15m" }, { symbol: "adausdt", period: "15m" }])
  ws.connect(); ws.connect()
  await vi.advanceTimersByTimeAsync(3100)
  expect(Socket.all).toHaveLength(2)
  const pub = Socket.all.find(s => s.url.endsWith("/public"))!
  const business = Socket.all.find(s => s.url.endsWith("/business"))!
  expect(Socket.all.every(s => !s.url.includes("token"))).toBe(true)
  pub.open(); business.open()
  await vi.advanceTimersByTimeAsync(1000)
  expect(pub.send.mock.calls.map(c => JSON.parse(c[0]))).toContainEqual({ op: "subscribe", args: [{ channel: "tickers", instId: "ADA-USDT-SWAP" }] })
  expect(business.send.mock.calls.map(c => JSON.parse(c[0]))).toContainEqual({ op: "subscribe", args: [{ channel: "candle15m", instId: "ADA-USDT-SWAP" }] })
  pub.frame({ arg: { channel: "tickers", instId: ticker.instId }, data: [ticker, { ...ticker, last: "0.2388", ts: "1791536400001" }] })
  await vi.advanceTimersByTimeAsync(300)
  expect(messages).toHaveBeenCalledWith({ type: "quote", data: [expect.objectContaining({ last_price: .2388 })] })
  business.frame({ arg: { channel: "candle15m", instId: ticker.instId }, data: [row] })
  expect(messages).toHaveBeenCalledWith({ type: "chart_kline", data: [expect.objectContaining({ symbol: "adausdt", period: "15m" })] })
  expect(ws.freshQuoteSymbols()).toEqual(["adausdt"])
  ws.setChartSubscription([])
  expect(business.close).toHaveBeenCalled()
  ws.disconnect()
  await vi.advanceTimersByTimeAsync(60000)
  expect(Socket.all).toHaveLength(2)
  expect(ws.freshQuoteSymbols()).toEqual([])
})
it("reconnects a half-open socket when pong is missing, even with quote traffic", async () => {
  ws.setQuoteSymbols(["adausdt"]); ws.connect()
  await vi.advanceTimersByTimeAsync(3100)
  const old = Socket.all[0]; old.open()
  await vi.advanceTimersByTimeAsync(16000)
  expect(old.send).toHaveBeenCalledWith("ping")
  old.frame({ arg: { channel: "tickers", instId: ticker.instId }, data: [ticker] })
  await vi.advanceTimersByTimeAsync(20000)
  expect(old.close).toHaveBeenCalled()
  expect(Socket.all.length).toBeGreaterThan(1)
  const latest = Socket.all.at(-1)!; latest.open()
  await vi.advanceTimersByTimeAsync(1000)
  expect(latest.send).toHaveBeenCalledWith(JSON.stringify({ op: "subscribe", args: [{ channel: "tickers", instId: ticker.instId }] }))
})
it("does not let unsolicited, stale or malformed frames suppress server fallback", async () => {
  ws.setQuoteSymbols(["adausdt"]); ws.connect(); await vi.advanceTimersByTimeAsync(3100)
  const pub = Socket.all[0]; pub.open()
  pub.frame({ arg: { channel: "tickers", instId: "BTC-USDT-SWAP" }, data: [{ ...ticker, instId: "BTC-USDT-SWAP" }] })
  pub.frame({ arg: { channel: "tickers", instId: ticker.instId }, data: [{ ...ticker, last: "broken" }] })
  expect(ws.freshQuoteSymbols()).toEqual([])
  pub.frame({ arg: { channel: "tickers", instId: ticker.instId }, data: [ticker] })
  expect(ws.freshQuoteSymbols()).toEqual(["adausdt"])
  await vi.advanceTimersByTimeAsync(16000)
  expect(ws.freshQuoteSymbols()).toEqual([])
})
