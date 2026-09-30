/**
 * Binance USDT-M aggTrade WS 客户端（流式打分预览数据源）。
 *
 * 直连公共流（无需鉴权）;断线自动重连并置 stale（由调用方判定分数过期）。
 * 纯预览用途——不涉及任何下单通道。
 */

import type { AggTradeEvent } from "./bucket-stream"

export interface AggTradeWsOptions {
  symbol: string
  onEvent: (e: AggTradeEvent) => void
  onStatus: (status: "connecting" | "open" | "closed") => void
}

export class AggTradeStream {
  readonly #opts: AggTradeWsOptions
  #ws: WebSocket | null = null
  #closedByUser = false
  #retry = 0

  constructor(opts: AggTradeWsOptions) {
    this.#opts = opts
  }

  start(): void {
    this.#closedByUser = false
    this.#connect()
  }

  stop(): void {
    this.#closedByUser = true
    this.#ws?.close()
    this.#ws = null
    this.#opts.onStatus("closed")
  }

  #connect(): void {
    if (this.#closedByUser) return
    const symbol = this.#opts.symbol.toLowerCase()
    const url = `wss://fstream.binance.com/ws/${symbol}@aggTrade`
    this.#opts.onStatus("connecting")
    try {
      this.#ws = new WebSocket(url)
    } catch {
      this.#scheduleReconnect()
      return
    }
    this.#ws.onopen = () => {
      this.#retry = 0
      this.#opts.onStatus("open")
    }
    this.#ws.onmessage = (ev) => {
      try {
        const data = JSON.parse(String(ev.data)) as { T?: number, p?: string, q?: string, m?: boolean }
        if (typeof data.T !== "number" || typeof data.p !== "string") return
        this.#opts.onEvent({ T: data.T, price: data.p, qty: data.q ?? "0", m: Boolean(data.m) })
      } catch {
        // 单帧异常不终止流
      }
    }
    this.#ws.onclose = () => {
      this.#opts.onStatus("closed")
      this.#scheduleReconnect()
    }
    this.#ws.onerror = () => {
      this.#ws?.close()
    }
  }

  #scheduleReconnect(): void {
    if (this.#closedByUser) return
    this.#retry += 1
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(this.#retry, 5))
    setTimeout(() => this.#connect(), delay)
  }
}
