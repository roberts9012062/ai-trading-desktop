"use client"

import { useEffect, useMemo } from "react"
import { cn } from "@/lib/utils"
import { useAppStore } from "@/stores/app"
import { useMarketStore } from "@/stores/market"
import type {
  MarketDepthField,
  OrderBook,
} from "@/types"
import { cryptoDepthStats, formatCoinQuantity } from "./crypto-depth"
import { isDepthDegraded, presentField } from "./market-depth-data.mjs"

type ValueKind = "price" | "lots" | "amount" | "percent" | "number"
type PriceSide = "ask" | "bid"

interface StatSpec {
  label: string
  key: string
  kind: ValueKind
}

const STAT_ROWS: Array<[StatSpec, StatSpec]> = [
  [{ label: "最新价", key: "last", kind: "price" }, { label: "24h涨跌", key: "change_pct", kind: "percent" }],
  [{ label: "24h开盘", key: "open", kind: "price" }, { label: "24h振幅", key: "amplitude", kind: "percent" }],
  [{ label: "24h最高", key: "high", kind: "price" }, { label: "24h最低", key: "low", kind: "price" }],
  [{ label: "买卖价差", key: "spread", kind: "price" }, { label: "价差比例", key: "spread_pct", kind: "percent" }],
]

function lookup<T>(record: Record<string, T>, symbol: string): T | undefined {
  return record[symbol] ?? record[symbol.toLowerCase()] ?? record[symbol.toUpperCase()]
}

function sourceLabel(source: string | undefined): string {
  const normalized = String(source ?? "").toLowerCase()
  if (normalized.includes("okx")) return "OKX"
  if (normalized.includes("binance")) return "Binance"
  if (normalized.includes("gate")) return "Gate"
  return "交易所行情"
}

function snapshotTime(asof: number | undefined, tickTime: string | undefined): string {
  if (asof && Number.isFinite(asof)) {
    return new Date(asof > 1e12 ? asof : asof * 1000).toLocaleTimeString("zh-CN", {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
  }
  const compact = String(tickTime ?? "")
  if (/^\d{6}$/.test(compact)) {
    return `${compact.slice(0, 2)}:${compact.slice(2, 4)}:${compact.slice(4)}`
  }
  return compact || "--"
}

function StatCell({
  spec,
  field,
  decimals,
  reference,
}: {
  spec: StatSpec
  field: MarketDepthField | undefined
  decimals: number
  reference: number
}): React.JSX.Element {
  const shown = presentField(field, spec.kind, decimals)
  const numeric = Number(field?.value)
  const isPrice = spec.kind === "price" && spec.key !== "spread" && field?.value != null && Number.isFinite(numeric) && reference > 0
  const tone = isPrice
    ? numeric > reference
      ? "text-up"
      : numeric < reference
        ? "text-down"
        : "text-[var(--text-primary)]"
    : spec.key === "change_pct" && Number.isFinite(numeric)
      ? numeric > 0
        ? "text-up"
        : numeric < 0
          ? "text-down"
          : "text-[var(--text-secondary)]"
      : "text-[var(--accent-info)]"

  return (
    <div className="grid grid-cols-[52px_1fr] items-center gap-1 px-2 py-[3px]">
      <span className="text-[12px] text-[var(--text-secondary)]">{spec.label}</span>
      <span className={cn("text-right font-num text-[13px]", tone)}>
        {shown.text}
        {shown.estimated && (
          <span className="ml-1 text-[9px] text-[var(--accent-warn)]">估</span>
        )}
      </span>
    </div>
  )
}

export function MarketDepthPanel({
  className,
  onPriceSelect,
}: {
  className?: string
  onPriceSelect?: (side: PriceSide, price: number) => void
}): React.JSX.Element {
  const activeContract = useAppStore((s) => s.activeContract)
  const orderbooks = useMarketStore((s) => s.orderbooks)
  const quotes = useMarketStore((s) => s.quotes)
  const initWebSocket = useMarketStore((s) => s.initWebSocket)

  useEffect(() => {
    initWebSocket()
  }, [initWebSocket])

  const quote = lookup(quotes, activeContract)
  const book: OrderBook | undefined = lookup(orderbooks, activeContract)
  const ask = book?.asks?.[0] ??
    (quote?.ask_price
      ? { price: quote.ask_price, volume: quote.ask_vol ?? 0 }
      : undefined)
  const bid = book?.bids?.[0] ??
    (quote?.bid_price
      ? { price: quote.bid_price, volume: quote.bid_vol ?? 0 }
      : undefined)
  const decimals = quote?.decimal_places ?? 2
  const reference = quote?.open_price ?? 0
  const spread = ask && bid && ask.price >= bid.price ? ask.price - bid.price : null
  const stats = useMemo(() => cryptoDepthStats(quote, spread), [quote, spread])
  const baseCoin = activeContract.replace(/usdt$/i, "").toUpperCase()
  const asks = (book?.asks?.length ? book.asks : ask ? [ask] : []).slice(0, 5)
  const bids = (book?.bids?.length ? book.bids : bid ? [bid] : []).slice(0, 5)
  const source = book?.source ?? quote?.source
  const stale = isDepthDegraded(book?.stale, quote?.simnow_stale)

  const PriceRow = ({
    label,
    side,
    level,
    tone,
  }: {
    label: string
    side: PriceSide
    level: { price: number; volume: number } | undefined
    tone: string
  }) => (
    <div className="grid grid-cols-[32px_1fr_88px] items-center px-2 py-1">
      <span className="text-[13px] text-[var(--text-primary)]">{label}</span>
      <button
        type="button"
        disabled={!onPriceSelect || !level}
        onClick={() => level && onPriceSelect?.(side, level.price)}
        className={cn(
          "text-left font-num text-[13px] font-semibold disabled:cursor-default",
          onPriceSelect && level && "hover:underline underline-offset-2",
          tone,
        )}
        title={onPriceSelect ? "点击填入限价单" : undefined}
      >
        {level ? level.price.toFixed(decimals) : "--"}
      </button>
      <span className="text-right font-num text-[12px] text-[var(--accent-info)]">
        {formatCoinQuantity(level?.volume)}
      </span>
    </div>
  )

  return (
    <section className={cn("flex h-full min-h-0 flex-col bg-[var(--bg-secondary)]", className)}>
      <div className="shrink-0 border-b border-[var(--border)] py-1">
        <div className="flex justify-between px-2 pb-1 text-[10px] text-[var(--text-muted)]"><span>价格（USDT）</span><span>数量（{baseCoin}）</span></div>
        {[...asks].reverse().map((level, i) => <PriceRow key={`ask-${i}`} label={`卖${asks.length - i}`} side="ask" level={level} tone="text-down" />)}
        {bids.map((level, i) => <PriceRow key={`bid-${i}`} label={`买${i + 1}`} side="bid" level={level} tone="text-up" />)}
        <div className="flex items-center justify-between px-2 pt-1 text-[10px] text-[var(--text-muted)]">
          <span>
            价差 {spread === null ? "--" : spread.toFixed(decimals)} · 最新{" "}
            {quote?.last_price?.toFixed(decimals) ?? "--"}
          </span>
          <span>{snapshotTime(book?.asof ?? quote?.recv_ts, quote?.tick_time)}</span>
        </div>
      </div>

      <div className="flex shrink-0 items-center justify-between border-b border-[var(--border)] px-2 py-1">
        <span className="text-[12px] text-[var(--text-primary)]">加密货币盘口</span>
        <span
          className={cn(
            "rounded px-1.5 py-0.5 text-[9px]",
            stale
              ? "bg-[var(--accent-warn)]/15 text-[var(--accent-warn)]"
              : "bg-[var(--accent-info)]/10 text-[var(--accent-info)]",
          )}
        >
          {sourceLabel(source)}{stale ? " · 已降级" : ""}
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        <div className="flex justify-between px-2 py-1 text-xs"><span className="text-[var(--text-secondary)]">24h成交量（{baseCoin}）</span><span className="font-num text-[var(--accent-info)]">{formatCoinQuantity(quote?.volume)}</span></div>
        {STAT_ROWS.map(([left, right]) => (
          <div key={left.key} className="grid grid-cols-2">
            <StatCell
              spec={left}
              field={stats[left.key]}
              decimals={decimals}
              reference={reference}
            />
            <StatCell
              spec={right}
              field={stats[right.key]}
              decimals={decimals}
              reference={reference}
            />
          </div>
        ))}
      </div>
    </section>
  )
}
