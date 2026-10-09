/** Public display market data only. Never attach product or exchange credentials. */
import type { KlineBar, TradeRecord } from "@/types"
import type { ChartSubscriptionKey, ConnectionState, MessageHandler, QuoteData, StateHandler } from "./websocket"

const PUBLIC_URL = "wss://okx-ws-test.kins.eu.org/ws/v5/public"
const BUSINESS_URL = "wss://okx-ws-test.kins.eu.org/ws/v5/business"
/** Native candle pushes can pause while no trades occur; unlike periodic VPS snapshots. */
export const OKX_SNIPPET_CANDLE_STALE_MS = 15000
const PERIODS: Record<string, string> = { "1m": "1m", "5m": "5m", "15m": "15m", "30m": "30m", "60m": "1H", "240m": "4H", "1d": "1D" }
const symbolOf = (id: unknown): string | null => typeof id === "string" && /^[A-Z0-9]{1,16}-USDT-SWAP$/.test(id) ? id.replace("-USDT-SWAP", "usdt").toLowerCase() : null
const instrumentOf = (symbol: string) => `${symbol.slice(0, -4).toUpperCase()}-USDT-SWAP`
const validSymbol = (symbol: string) => /^[a-z0-9]{1,16}usdt$/.test(symbol)
type Arg = { channel: string; instId: string }
const argKey = (arg: Arg) => `${arg.channel}:${arg.instId}`

function beijingTime(ms: number, daily = false): string {
  return new Date(ms + 8 * 3600000).toISOString().replace("T", " ").slice(0, daily ? 10 : 19)
}

export function decodeOkxCandle(raw: unknown, period: string, version: number): KlineBar | null {
  if (!Array.isArray(raw) || raw.length < 9 || !PERIODS[period]) return null
  const [ts, open, high, low, close, contracts, volume, quoteVolume] = raw.slice(0, 8).map(Number)
  if (![ts, open, high, low, close, contracts, volume, quoteVolume].every(Number.isFinite) || ts <= 0 || ts > 8640000000000000 - 28800000 ||
    Math.min(open, high, low, close) <= 0 || Math.min(contracts, volume, quoteVolume) < 0 ||
    high < Math.max(open, low, close) || low > Math.min(open, high, close) || !["0", "1"].includes(String(raw[8]))) return null
  return { time: beijingTime(ts, period === "1d"), open, high, low, close, volume,
    market_source: "okx", is_closed: String(raw[8]) === "1", version, kind: "correction" }
}

export function decodeOkxTicker(raw: unknown): QuoteData | null {
  if (!raw || typeof raw !== "object") return null
  const r = raw as Record<string, unknown>, symbol = symbolOf(r.instId)
  const price = Number(r.last), ts = Number(r.ts), open = Number(r.open24h)
  if (!symbol || !Number.isFinite(price) || price <= 0 || !Number.isFinite(ts) || ts <= 0 || ts > 8640000000000000 - 28800000) return null
  const nonnegative = (v: unknown) => Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : 0
  const baseVolume = nonnegative(r.volCcy24h), contracts = nonnegative(r.vol24h)
  // For linear USDT swaps the ratio is the fixed base-coin contract value.
  const contractValue = contracts > 0 ? baseVolume / contracts : 0
  const previous = Number.isFinite(open) && open > 0 ? open : price
  return { symbol, name: symbol.toUpperCase(), exchange: "OKX", last_price: price,
    change: price - previous, change_pct: (price / previous - 1) * 100,
    open_price: previous, high_price: nonnegative(r.high24h), low_price: nonnegative(r.low24h), pre_close: previous,
    bid_price: nonnegative(r.bidPx), ask_price: nonnegative(r.askPx), bid_vol: nonnegative(r.bidSz) * contractValue,
    ask_vol: nonnegative(r.askSz) * contractValue, volume: baseVolume, position: 0,
    tick_time: beijingTime(ts), recv_ts: ts, decimal_places: String(r.last).split(".")[1]?.length ?? 0,
    source: "okx-snippet" }
}

/** One reusable socket per endpoint; subscriptions are diffed, never per-page sockets. */
class PublicChannel {
  state: ConnectionState = "disconnected"
  private socket: WebSocket | null = null
  private desired = new Map<string, Arg>()
  private sent = new Map<string, Arg>()
  private running = false
  private attempt = 0
  private lastReceive = 0
  private lastMarket = 0
  private pingAt = 0
  private lastPing = 0
  private dial: ReturnType<typeof setTimeout> | null = null
  private heartbeat: ReturnType<typeof setInterval> | null = null
  private operations: ReturnType<typeof setTimeout> | null = null
  private operationTimes: number[] = []
  constructor(private url: string, private budget: { next: number },
    private frame: (frame: Record<string, unknown>) => boolean,
    private changed: (state: ConnectionState) => void) {}

  setDesired(args: Arg[]): void {
    this.desired = new Map(args.map(arg => [argKey(arg), arg]))
    if (!args.length) { this.stopSocket(); this.setState("disconnected"); return }
    if (this.socket?.readyState === 1) this.queueOperations()
    else this.ensureConnection()
  }
  setRunning(running: boolean): void {
    this.running = running
    if (running) this.ensureConnection()
    else { this.stopSocket(); this.attempt = 0; this.setState("disconnected") }
  }
  private setState(state: ConnectionState) { this.state = state; this.changed(state) }
  private ensureConnection(delay = 0): void {
    if (!this.running || !this.desired.size || this.dial !== null || this.socket) return
    this.setState(this.attempt ? "reconnecting" : "connecting")
    const now = Date.now(), at = Math.max(now + delay, this.budget.next)
    this.budget.next = at + 1500
    this.dial = setTimeout(() => { this.dial = null; this.open() }, at - now)
  }
  private open(): void {
    if (!this.running || !this.desired.size) return
    let socket: WebSocket
    try { socket = new WebSocket(this.url) } catch { this.retry(); return }
    this.socket = socket
    this.lastReceive = this.lastMarket = this.lastPing = Date.now(); this.pingAt = 0
    this.heartbeat = setInterval(() => {
      const now = Date.now()
      if (socket !== this.socket) return
      if (socket.readyState === 0 && now - this.lastReceive > 12000) { this.retry(); return }
      if (socket.readyState !== 1) return
      if ((this.pingAt && now - this.pingAt >= 10000) || now - this.lastMarket > 45000) { this.retry(); return }
      if (!this.pingAt && now - this.lastPing >= 15000) {
        this.pingAt = this.lastPing = now
        try { socket.send("ping") } catch { this.retry() }
      }
    }, 1000)
    socket.onopen = () => {
      if (socket !== this.socket) return
      this.lastReceive = this.lastMarket = this.lastPing = Date.now()
      this.sent.clear(); this.operationTimes = []
      this.setState("connected"); this.queueOperations()
    }
    socket.onmessage = event => {
      if (socket !== this.socket || typeof event.data !== "string") return
      this.lastReceive = Date.now()
      if (event.data === "pong") { this.pingAt = 0; return }
      try {
        const frame = JSON.parse(event.data)
        if (!frame || typeof frame !== "object") return
        if (frame.event === "error") {
          // Invalid/delisted subscriptions retain the server fallback for that symbol.
          return
        }
        if (this.frame(frame)) { this.lastMarket = Date.now(); this.attempt = 0 }
      } catch { /* Invalid frames never count as fresh market data. */ }
    }
    socket.onclose = () => { if (socket === this.socket) this.retry() }
    socket.onerror = () => { if (socket === this.socket) this.retry() }
  }
  private retry(): void {
    this.stopSocket()
    const delay = Math.min(30000, 2000 * 2 ** Math.min(this.attempt++, 4)) + Math.floor(Math.random() * 1000)
    this.ensureConnection(delay)
  }
  private queueOperations(delay = 0): void {
    if (this.operations !== null || this.socket?.readyState !== 1) return
    this.operations = setTimeout(() => {
      this.operations = null
      if (this.socket?.readyState !== 1) return
      const now = Date.now()
      this.operationTimes = this.operationTimes.filter(at => now - at < 3600000)
      if (this.operationTimes.length >= 400) { this.queueOperations(this.operationTimes[0] + 3600001 - now); return }
      const removed = [...this.sent].filter(([key]) => !this.desired.has(key)).map(([, arg]) => arg)
      const added = [...this.desired].filter(([key]) => !this.sent.has(key)).map(([, arg]) => arg)
      const op = removed.length ? "unsubscribe" : "subscribe", args = (removed.length ? removed : added).slice(0, 500)
      if (!args.length) return
      try { this.socket.send(JSON.stringify({ op, args })) } catch { this.retry(); return }
      this.operationTimes.push(now)
      for (const arg of args) { if (op === "subscribe") this.sent.set(argKey(arg), arg); else this.sent.delete(argKey(arg)) }
      this.queueOperations(500)
    }, delay)
  }
  private stopSocket(): void {
    if (this.dial !== null) clearTimeout(this.dial)
    if (this.heartbeat !== null) clearInterval(this.heartbeat)
    if (this.operations !== null) clearTimeout(this.operations)
    this.dial = this.heartbeat = this.operations = null
    const old = this.socket; this.socket = null; this.sent.clear(); this.pingAt = 0
    if (old) {
      old.onopen = old.onmessage = old.onclose = old.onerror = null
      try { old.close(1000, "market stream replaced") } catch { /* Already closed. */ }
    }
  }
}

export class OkxSnippetWebSocket {
  private handlers = new Set<MessageHandler>()
  private chartStates = new Set<StateHandler>()
  private quoteStates = new Set<StateHandler>()
  private freshnessHandlers = new Set<(symbols: string[]) => void>()
  private freshnessTimer: ReturnType<typeof setInterval> | null = null
  private quoteSymbols = new Set<string>()
  private depthSymbols = new Set<string>()
  private contractValues = new Map<string, number>()
  private depthHeads = new Map<string, number>()
  private recentTrades = new Map<string, Map<string, TradeRecord>>()
  private chartKeys = new Set<string>()
  private fresh = new Map<string, { at: number; ts: number }>()
  private candleHeads = new Map<string, { time: number; closed: boolean; at: number }>()
  private pendingQuotes = new Map<string, QuoteData>()
  private flush: ReturnType<typeof setTimeout> | null = null
  private version = 0
  private publicChannel: PublicChannel
  private businessChannel: PublicChannel
  constructor() {
    const budget = { next: 0 }
    this.publicChannel = new PublicChannel(PUBLIC_URL, budget, frame => this.receiveQuote(frame) || this.receiveDepth(frame), state => {
      if (state !== "connected") { this.fresh.clear(); this.pendingQuotes.clear(); this.depthHeads.clear() }
      this.quoteStates.forEach(handler => handler(state))
      this.emitFreshness()
    })
    this.businessChannel = new PublicChannel(BUSINESS_URL, budget, frame => this.receiveCandle(frame), state => {
      this.chartStates.forEach(handler => handler(state))
    })
  }
  get state(): ConnectionState { return this.businessChannel.state }
  onMessage(handler: MessageHandler) { this.handlers.add(handler); return () => { this.handlers.delete(handler) } }
  onStateChange(handler: StateHandler) { this.chartStates.add(handler); return () => { this.chartStates.delete(handler) } }
  onQuoteStateChange(handler: StateHandler) { this.quoteStates.add(handler); return () => { this.quoteStates.delete(handler) } }
  onQuoteFreshnessChange(handler: (symbols: string[]) => void) { this.freshnessHandlers.add(handler); return () => { this.freshnessHandlers.delete(handler) } }
  connect(): void {
    if (this.freshnessTimer === null) this.freshnessTimer = setInterval(() => this.emitFreshness(), 5000)
    this.publicChannel.setRunning(true); this.businessChannel.setRunning(true)
  }
  disconnect(): void {
    this.publicChannel.setRunning(false); this.businessChannel.setRunning(false)
    if (this.flush !== null) clearTimeout(this.flush)
    if (this.freshnessTimer !== null) clearInterval(this.freshnessTimer)
    this.freshnessTimer = null
    this.flush = null; this.fresh.clear(); this.pendingQuotes.clear(); this.candleHeads.clear()
  }
  observeVersion(version: number | undefined): void {
    if (typeof version === "number" && Number.isFinite(version)) this.version = Math.max(this.version, version)
  }
  setQuoteSymbols(symbols: string[]): void {
    this.quoteSymbols = new Set(symbols.map(s => s.trim().toLowerCase()).filter(validSymbol).slice(0, 1024))
    for (const key of this.fresh.keys()) if (!this.quoteSymbols.has(key)) { this.fresh.delete(key); this.pendingQuotes.delete(key) }
    this.syncPublicSubscriptions()
  }
  setDepthSymbols(symbols: string[]): void {
    this.depthSymbols = new Set(symbols.map(s => s.trim().toLowerCase()).filter(validSymbol).slice(0, 32))
    for (const symbol of this.recentTrades.keys()) if (!this.depthSymbols.has(symbol)) this.recentTrades.delete(symbol)
    this.syncPublicSubscriptions()
  }
  private syncPublicSubscriptions(): void {
    const args: Arg[] = [...new Set([...this.quoteSymbols, ...this.depthSymbols])].sort().map(symbol => ({ channel: "tickers", instId: instrumentOf(symbol) }))
    for (const symbol of this.depthSymbols) for (const channel of ["books5", "trades"]) args.push({channel, instId: instrumentOf(symbol)})
    this.publicChannel.setDesired(args)
  }
  hasFreshDepth(symbol: string): boolean {
    return this.publicChannel.state === 'connected' && Date.now() - (this.depthHeads.get(symbol) ?? 0) < 15000
  }
  setChartSubscription(keys: ChartSubscriptionKey[]): void {
    const args = new Map<string, Arg>()
    for (const { symbol: raw, period } of keys) {
      const symbol = raw.trim().toLowerCase()
      if (validSymbol(symbol) && PERIODS[period]) args.set(`${symbol}:${period}`, { channel: `candle${PERIODS[period]}`, instId: instrumentOf(symbol) })
    }
    this.chartKeys = new Set([...args.keys()].slice(0, 32))
    for (const key of this.candleHeads.keys()) if (!this.chartKeys.has(key)) this.candleHeads.delete(key)
    this.businessChannel.setDesired([...args.values()].slice(0, 32))
  }
  freshQuoteSymbols(): string[] { return [...this.fresh].filter(([, value]) => Date.now() - value.at <= 15000).map(([symbol]) => symbol).sort() }
  hasFreshQuote(symbol: string): boolean { const value = this.fresh.get(symbol.toLowerCase()); return !!value && Date.now() - value.at <= 15000 }
  hasFreshCandle(symbol: string, period: string): boolean {
    const head = this.candleHeads.get(`${symbol.toLowerCase()}:${period}`)
    return this.state === "connected" && !!head && Date.now() - head.at <= OKX_SNIPPET_CANDLE_STALE_MS
  }
  private emitFreshness(): void {
    const symbols = this.freshQuoteSymbols()
    this.freshnessHandlers.forEach(handler => handler(symbols))
  }
  private receiveQuote(frame: Record<string, unknown>): boolean {
    const arg = frame.arg as Arg | undefined
    if (arg?.channel !== "tickers" || !Array.isArray(frame.data)) return false
    let valid = false
    for (const raw of frame.data) {
      const quote = decodeOkxTicker(raw)
      if (!quote || arg.instId !== (raw as Record<string, unknown>).instId || (!this.quoteSymbols.has(quote.symbol) && !this.depthSymbols.has(quote.symbol))) continue
      const native = raw as Record<string, unknown>
      const value = Number(native.volCcy24h) / Number(native.vol24h)
      if (Number.isFinite(value) && value > 0) this.contractValues.set(quote.symbol, value)
      const prev = this.fresh.get(quote.symbol)
      if (prev && quote.recv_ts! <= prev.ts) continue
      this.fresh.set(quote.symbol, { at: Date.now(), ts: quote.recv_ts! }); this.pendingQuotes.set(quote.symbol, quote); valid = true
    }
    if (this.pendingQuotes.size && this.flush === null) this.flush = setTimeout(() => {
      this.flush = null
      const data = [...this.pendingQuotes.values()]; this.pendingQuotes.clear()
      if (data.length) this.handlers.forEach(handler => handler({ type: "quote", data }))
      this.emitFreshness()
    }, 250)
    return valid
  }
  private receiveDepth(frame: Record<string, unknown>): boolean {
    const arg = frame.arg as Arg | undefined, symbol = symbolOf(arg?.instId)
    if (!symbol || !this.depthSymbols.has(symbol) || !Array.isArray(frame.data)) return false
    const value = this.contractValues.get(symbol)
    if (!value) return false // Never present contract counts as base-coin quantities.
    if (arg?.channel === 'books5') {
      const row = frame.data[0] as {asks?: unknown[][]; bids?: unknown[][]; ts?: string} | undefined
      if (!row || !Array.isArray(row.asks) || !Array.isArray(row.bids) || !Number.isFinite(Number(row.ts))) return false
      const levels = (rows: unknown[][]) => rows.slice(0,5).map(r => ({price:Number(r[0]),volume:Number(r[1])*value}))
      const asks=levels(row.asks),bids=levels(row.bids)
      if (![...asks,...bids].every(l => Number.isFinite(l.price) && l.price>0 && Number.isFinite(l.volume) && l.volume>=0)) return false
      this.depthHeads.set(symbol,Date.now())
      this.handlers.forEach(h => h({type:'orderbook',data:[{symbol,asks,bids,source:'okx-snippet',asof:Number(row.ts),stale:false}]}))
      return true
    }
    if (arg?.channel !== 'trades') return false
    const recent = this.recentTrades.get(symbol) ?? new Map<string,TradeRecord>()
    let valid=false
    for (const raw of frame.data) {
      const r=raw as Record<string,unknown>,price=Number(r.px),volume=Number(r.sz)*value,ts=Number(r.ts)
      if (!Number.isFinite(price) || price<=0 || !Number.isFinite(volume) || volume<0 || !Number.isFinite(ts) || ts<=0 || ts>8640000000000000-28800000 || !['buy','sell'].includes(String(r.side)) || !r.tradeId) continue
      recent.set(String(r.tradeId),{time:beijingTime(ts).slice(11),price,volume,direction:r.side as 'buy'|'sell',source:'realtime',ts:String(ts)})
      valid=true
    }
    const sorted=[...recent.entries()].sort((a,b)=>Number(b[1].ts)-Number(a[1].ts)).slice(0,30)
    this.recentTrades.set(symbol,new Map(sorted))
    if (valid) this.handlers.forEach(h => h({type:'trades',data:{[symbol]:sorted.map(([,trade])=>trade)}}))
    return valid
  }
  private receiveCandle(frame: Record<string, unknown>): boolean {
    const arg = frame.arg as Arg | undefined, symbol = symbolOf(arg?.instId)
    const period = Object.keys(PERIODS).find(p => `candle${PERIODS[p]}` === arg?.channel)
    if (!symbol || !period || !this.chartKeys.has(`${symbol}:${period}`) || !Array.isArray(frame.data)) return false
    const key = `${symbol}:${period}`, frames: Array<{ symbol: string; period: string; bar: KlineBar }> = []
    for (const raw of frame.data) {
      this.version = Math.max(Date.now(), this.version + 1)
      const bar = decodeOkxCandle(raw, period, this.version)
      if (!bar) continue
      const time = Number(raw[0]), head = this.candleHeads.get(key)
      if (head && (time < head.time || (time === head.time && head.closed && !bar.is_closed))) continue
      this.candleHeads.set(key, { time, closed: !!bar.is_closed, at: Date.now() }); frames.push({ symbol, period, bar })
    }
    if (frames.length) this.handlers.forEach(handler => handler({ type: "chart_kline", data: frames }))
    return frames.length > 0
  }
}

let instance: OkxSnippetWebSocket | null = null
export function getOkxSnippetWebSocket(): OkxSnippetWebSocket {
  if (!instance) {
    instance = new OkxSnippetWebSocket()
    if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
      window.addEventListener("pagehide", () => instance?.disconnect())
    }
  }
  return instance
}
