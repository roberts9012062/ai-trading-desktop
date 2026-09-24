"use client"

/**
 * K 线十字线悬浮小盘口 —— 鼠标在 K 线上移动时跟随光标展示迷你五档，
 * 移开（未接触任何蜡烛）由父级隐藏。
 */

import type { OrderBook } from "@/types"
import type { QuoteData } from "@/lib/websocket"

const PANEL_W = 176

function fmt(v: number | undefined, decimals: number): string {
  if (v == null || !Number.isFinite(v)) return "--"
  return v.toFixed(decimals)
}

export function KlineHoverBookPanel(props: {
  x: number
  y: number
  book: OrderBook
  quote: QuoteData | undefined
}): React.JSX.Element | null {
  const { book, quote } = props
  const decimals = quote?.decimal_places ?? 2
  const asks = (book.asks ?? []).slice(0, 4)
  const bids = (book.bids ?? []).slice(0, 4)
  if (asks.length === 0 && bids.length === 0) return null

  const bid1 = bids[0]?.price ?? 0
  const ask1 = asks[0]?.price ?? 0
  const spread = ask1 > 0 && bid1 > 0 ? ask1 - bid1 : null

  // 光标靠右时翻到左侧，避免溢出
  const left = props.x > 480 ? props.x - PANEL_W - 16 : props.x + 16
  const top = Math.max(props.y - 60, 4)

  return (
    <div
      className="absolute z-30 pointer-events-none rounded-md border border-[var(--border)] bg-[var(--bg-secondary)]/95 backdrop-blur-sm shadow-lg py-1.5 px-0"
      style={{ left, top, width: PANEL_W }}
    >
      <div className="px-2 pb-1 text-[10px] text-[var(--text-muted)] flex justify-between">
        <span>盘口</span>
        <span className="font-num">
          {fmt(quote?.last_price, decimals)}
        </span>
      </div>
      {/* 卖档：卖4在上、卖1贴中 */}
      {[...asks].reverse().map((lv, i) => (
        <div
          key={`a${i}`}
          className="flex justify-between px-2 py-[1px] text-[10px] font-num text-up"
        >
          <span className="text-[var(--text-muted)]">卖{asks.length - i}</span>
          <span>{fmt(lv.price, decimals)}</span>
          <span className="text-[var(--text-muted)] w-10 text-right">
            {lv.volume}
          </span>
        </div>
      ))}
      {spread !== null && (
        <div className="flex justify-between px-2 py-[1px] text-[10px] font-num text-[var(--text-muted)] border-y border-[var(--border)]/60 my-0.5">
          <span>价差</span>
          <span>{fmt(spread, decimals)}</span>
        </div>
      )}
      {bids.map((lv, i) => (
        <div
          key={`b${i}`}
          className="flex justify-between px-2 py-[1px] text-[10px] font-num text-down"
        >
          <span className="text-[var(--text-muted)]">买{i + 1}</span>
          <span>{fmt(lv.price, decimals)}</span>
          <span className="text-[var(--text-muted)] w-10 text-right">
            {lv.volume}
          </span>
        </div>
      ))}
    </div>
  )
}
