"use client"

/**
 * 挂单线 + 持仓成本线 + 模拟账户轮询（行情/交易页共用）
 *
 * source 过滤：all=全部来源（行情/交易/AI 看盘页，含 AI/量化任务持仓）；
 * manual=仅用户手动单（备用选项）。
 */

import { useEffect, useMemo, type MutableRefObject } from "react"
import type { ISeriesApi } from "lightweight-charts"
import { useMarketStore } from "@/stores/market"
import { usePaperTradingStore } from "@/stores/paper-trading"
import { useOrderPriceLines } from "./use-order-lines"
import { usePositionPriceLines } from "./use-position-lines"

/** 画线来源范围 */
export type TradeLinesSource = "all" | "manual"

export function useTradeLines(props: {
  seriesRef: MutableRefObject<ISeriesApi<"Candlestick"> | null>
  activeContract: string
  chartReady: number
  seriesReady: number
  enabled?: boolean
  source?: TradeLinesSource
}): void {
  const {
    seriesRef,
    activeContract,
    chartReady,
    seriesReady,
    enabled: enabledProp,
    source = "all",
  } = props
  const enabled = enabledProp !== false
  const orders = usePaperTradingStore((s) => s.orders)
  const positions = usePaperTradingStore((s) => s.positions)
  const refreshPaper = usePaperTradingStore((s) => s.refresh)
  const quote = useMarketStore(
    (s) =>
      s.quotes[activeContract] ??
      s.quotes[activeContract.toLowerCase()] ??
      s.quotes[activeContract.toUpperCase()]
  )

  const pendingOrders = useMemo(
    () =>
      enabled
        ? orders.filter(
            (o) =>
              // 实盘挂单状态为交易所原生（live/NEW/open），虚拟盘为 pending
              ["pending", "live", "NEW", "new", "open"].includes(o.status) &&
              o.order_type === "limit" &&
              (source === "all" || o.source === "manual"),
          )
        : [],
    [orders, enabled, source],
  )

  useEffect(() => {
    if (!enabled) return
    void refreshPaper()
    const timer = setInterval(() => {
      void refreshPaper()
    }, 10_000)
    return () => clearInterval(timer)
  }, [refreshPaper, activeContract, enabled])

  useOrderPriceLines({
    seriesRef,
    pendingOrders,
    activeContract,
    chartReady,
    seriesReady,
  })

  usePositionPriceLines({
    seriesRef,
    positions: enabled
      ? positions.filter(
          (p) => p.quantity > 0 && (source === "all" || p.source === "manual"),
        )
      : [],
    activeContract,
    lastPrice: quote?.last_price ?? 0,
    chartReady,
    seriesReady,
  })
}
