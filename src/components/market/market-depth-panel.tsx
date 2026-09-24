"use client"

import { useEffect, useMemo } from "react"
import { cn } from "@/lib/utils"
import { useAppStore } from "@/stores/app"
import { useMarketStore } from "@/stores/market"
import type {
  MarketDepthField,
  MarketDepthStats,
  OrderBook,
} from "@/types"
import { isDepthDegraded, presentField } from "./market-depth-data.mjs"

type ValueKind = "price" | "lots" | "amount" | "percent" | "number"
type PriceSide = "ask" | "bid"

interface StatSpec {
  label: string
  key: string
  kind: ValueKind
}

const STAT_ROWS: Array<[StatSpec, StatSpec]> = [
  [
    { label: "开盘", key: "open_price", kind: "price" },
    { label: "日增仓", key: "daily_oi_change", kind: "lots" },
  ],
  [
    { label: "涨停", key: "upper_limit_price", kind: "price" },
    { label: "昨持仓", key: "pre_open_interest", kind: "lots" },
  ],
  [
    { label: "跌停", key: "lower_limit_price", kind: "price" },
    { label: "持仓", key: "open_interest", kind: "lots" },
  ],
  [
    { label: "最高", key: "high_price", kind: "price" },
    { label: "振幅", key: "amplitude", kind: "percent" },
  ],
  [
    { label: "最低", key: "low_price", kind: "price" },
    { label: "现手", key: "current_volume", kind: "lots" },
  ],
  [
    { label: "均价", key: "average_price", kind: "price" },
    { label: "成交量", key: "volume", kind: "lots" },
  ],
  [
    { label: "量比", key: "volume_ratio", kind: "number" },
    { label: "成交额", key: "turnover", kind: "amount" },
  ],
  [
    { label: "昨结", key: "pre_settlement_price", kind: "price" },
    { label: "外盘", key: "outer_volume", kind: "lots" },
  ],
  [
    { label: "今结", key: "settlement_price", kind: "price" },
    { label: "内盘", key: "inner_volume", kind: "lots" },
  ],
  [
    { label: "基差", key: "basis", kind: "price" },
    { label: "现货", key: "spot", kind: "price" },
  ],
]

function lookup<T>(record: Record<string, T>, symbol: string): T | undefined {
  return record[symbol] ?? record[symbol.toLowerCase()] ?? record[symbol.toUpperCase()]
}

function direct(value: number | null | undefined, source: string): MarketDepthField {
  return value === null || value === undefined || !Number.isFinite(value)
    ? { value: null, source: "missing", quality: "missing" }
    : { value, source, quality: "direct" }
}

function fallbackStats(
  quote:
    | {
        source?: string
        open_price?: number
        high_price?: number
        low_price?: number
        pre_close?: number
        volume?: number
        position?: number
      }
    | undefined,
): MarketDepthStats {
  const source = quote?.source ?? "quote"
  return {
    open_price: direct(quote?.open_price, source),
    high_price: direct(quote?.high_price, source),
    low_price: direct(quote?.low_price, source),
    pre_settlement_price: direct(quote?.pre_close, source),
    volume: direct(quote?.volume, source),
    open_interest: direct(quote?.position, source),
  }
}

function sourceLabel(source: string | undefined): string {
  const normalized = String(source ?? "").toLowerCase()
  if (normalized.includes("simnow")) return "SimNow"
  if (normalized.includes("sina")) return "新浪兜底"
  if (normalized.includes("openctp") || normalized.includes("virtual")) {
    return "仿真行情"
  }
  return "行情"
}

function snapshotTime(asof: number | undefined, tickTime: string | undefined): string {
  if (asof && Number.isFinite(asof)) {
    return new Date(asof * 1000).toLocaleTimeString("zh-CN", {
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
  const isPrice = spec.kind === "price" && Number.isFinite(numeric) && reference > 0
  const tone = isPrice
    ? numeric > reference
      ? "text-up"
      : numeric < reference
        ? "text-down"
        : "text-[var(--text-primary)]"
    : spec.key === "daily_oi_change" && Number.isFinite(numeric)
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
  const stats = useMemo(
    () => ({ ...fallbackStats(quote), ...(book?.stats ?? {}) }),
    [book?.stats, quote],
  )
  const ask = book?.asks?.[0] ??
    (quote?.ask_price
      ? { price: quote.ask_price, volume: quote.ask_vol ?? 0 }
      : undefined)
  const bid = book?.bids?.[0] ??
    (quote?.bid_price
      ? { price: quote.bid_price, volume: quote.bid_vol ?? 0 }
      : undefined)
  const decimals = quote?.decimal_places ?? 0
  const reference = Number(stats.pre_settlement_price?.value ?? quote?.pre_close ?? 0)
  const spread = ask && bid ? ask.price - bid.price : null
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
    <div className="grid grid-cols-[44px_1fr_64px] items-center px-2 py-1">
      <span className="text-[13px] text-[var(--text-primary)]">{label}</span>
      <button
        type="button"
        disabled={!onPriceSelect || !level}
        onClick={() => level && onPriceSelect?.(side, level.price)}
        className={cn(
          "text-left font-num text-[17px] font-semibold disabled:cursor-default",
          onPriceSelect && level && "hover:underline underline-offset-2",
          tone,
        )}
        title={onPriceSelect ? "点击填入限价单" : undefined}
      >
        {level ? level.price.toFixed(decimals) : "--"}
      </button>
      <span className="text-right font-num text-[15px] text-[var(--accent-info)]">
        {level ? level.volume : "--"}
      </span>
    </div>
  )

  return (
    <section className={cn("flex h-full min-h-0 flex-col bg-[var(--bg-secondary)]", className)}>
      <div className="shrink-0 border-b border-[var(--border)] py-1">
        <PriceRow label="卖价" side="ask" level={ask} tone="text-down" />
        <PriceRow label="买价" side="bid" level={bid} tone="text-up" />
        <div className="flex items-center justify-between px-2 pt-1 text-[10px] text-[var(--text-muted)]">
          <span>
            价差 {spread === null ? "--" : spread.toFixed(decimals)} · 最新{" "}
            {quote?.last_price?.toFixed(decimals) ?? "--"}
          </span>
          <span>{snapshotTime(book?.asof ?? quote?.recv_ts, quote?.tick_time)}</span>
        </div>
      </div>

      <div className="flex shrink-0 items-center justify-between border-b border-[var(--border)] px-2 py-1">
        <span className="text-[12px] text-[var(--text-primary)]">盘口数据</span>
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
