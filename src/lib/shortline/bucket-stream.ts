/**
 * 1 秒桶累积器 —— WS aggTrade 事件与归档 CSV 行的统一入口。
 *
 * 重放器、流式预览、回填聚合共用：原始成交 → TickBucket 序列。
 * 纯函数式追加；同一输入序列产出逐位一致的桶序列（无时间读取、无随机）。
 */

import type { TickBucket } from "./digest"

/** Binance WS aggTrade 事件形态（futures/um） */
export interface AggTradeEvent {
  /** 事件时间（毫秒） */
  T: number
  price: string | number
  qty: string | number
  /** 主动买方 true / 主动卖方 false */
  m: boolean
  /** 成交笔数聚合（aggTrade 为聚合价；quote = price*qty） */
  n?: number
}

/** Binance Vision daily aggTrades CSV 行（无表头）:
 * agg_trade_id, price, quantity, first_trade_id, last_trade_id, transact_time_ms, is_buyer_maker */
export interface AggTradeCsvRow {
  price: number
  qty: number
  transactTimeMs: number
  isBuyerMaker: boolean
}

function bucketOf(tsSec: number, price: number, qty: number, isBuyerMaker: boolean, count: number): TickBucket {
  const quote = price * qty
  return {
    ts: tsSec, open: price, high: price, low: price, close: price,
    vol: qty, quote, takerBuyVol: isBuyerMaker ? 0 : qty, takerBuyQuote: isBuyerMaker ? 0 : quote,
    count,
  }
}

/** 事件流累积器：按秒分桶，乱序容忍 0（要求时间单调，否则抛错——冻结数据集不允许乱序） */
export class BucketAccumulator {
  private buckets: TickBucket[] = []
  private lastTs = -1

  pushEvent(e: AggTradeEvent): void {
    const price = Number(e.price)
    const qty = Number(e.qty)
    if (!Number.isFinite(price) || !Number.isFinite(qty)) throw new Error("aggTrade 数值非法")
    const ts = Math.floor((e.T || 0) / 1000)
    this.#append(ts, price, qty, e.m, Math.max(1, Number(e.n) || 1))
  }

  pushCsvRow(r: AggTradeCsvRow): void {
    if (!Number.isFinite(r.price) || !Number.isFinite(r.qty)) throw new Error("aggTrade CSV 数值非法")
    const ts = Math.floor(r.transactTimeMs / 1000)
    // is_buyer_maker=true → 主动卖方（买方是挂单方）
    this.#append(ts, r.price, r.qty, r.isBuyerMaker, 1)
  }

  #append(ts: number, price: number, qty: number, isBuyerMaker: boolean, count: number): void {
    if (ts < this.lastTs) throw new Error(`aggTrade 时间回退: ${ts} < ${this.lastTs}`)
    if (ts === this.lastTs) {
      const b = this.buckets[this.buckets.length - 1]!
      if (price > b.high) b.high = price
      if (price < b.low) b.low = price
      b.close = price
      b.vol += qty
      b.quote += price * qty
      if (!isBuyerMaker) {
        b.takerBuyVol += qty
        b.takerBuyQuote += price * qty
      }
      b.count += count
      return
    }
    this.buckets.push(bucketOf(ts, price, qty, isBuyerMaker, count))
    this.lastTs = ts
  }

  /** 当前桶序列（引用；调用方不应修改） */
  list(): readonly TickBucket[] {
    return this.buckets
  }

  get length(): number {
    return this.buckets.length
  }
}

/** 归档 CSV 解析（Binance Vision daily aggTrades zip 内文本） */
export function parseAggTradesCsv(text: string, onRow: (r: AggTradeCsvRow) => void): number {
  let n = 0
  for (const line of text.split("\n")) {
    const s = line.trim()
    if (!s) continue
    const cols = s.split(",")
    if (cols.length < 7) continue
    // 跳过可能存在的表头行
    const price = Number(cols[1]), qty = Number(cols[2]), t = Number(cols[5])
    if (!Number.isFinite(price) || !Number.isFinite(qty) || !Number.isFinite(t)) continue
    onRow({ price, qty, transactTimeMs: t, isBuyerMaker: cols[6]!.trim() === "true" })
    n++
  }
  return n
}
