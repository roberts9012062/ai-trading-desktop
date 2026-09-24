"use client"

/**
 * 在 K 线主图上绘制挂单价格线
 *
 * 依赖 seriesReady：蜡烛 series 重建后递增，确保离开再回来能重画。
 */

import { useEffect, type MutableRefObject } from "react"
import type { IPriceLine, ISeriesApi } from "lightweight-charts"
import type { PaperOrderItem } from "@/lib/paper-api"

function lineTitle(order: PaperOrderItem): string {
  // 方向语义：开买=多 / 开卖=空 / 平仓
  const dir =
    order.offset === "close"
      ? "平仓"
      : order.direction === "buy"
        ? "挂多"
        : "挂空"
  const lev =
    order.leverage && order.leverage > 0 ? ` ×${order.leverage}倍` : ""
  const qty = Number(order.quantity)
  const qtyLabel =
    qty >= 1 ? qty.toFixed(2).replace(/\.?0+$/, "") : String(qty)
  return `${dir}${lev} ${qtyLabel} @${order.price}`
}

/** 国内期货习惯：买红 / 卖绿 / 平仓紫（细虚线挂单） */
function lineColor(order: PaperOrderItem): string {
  if (order.offset === "close") {
    return "#a855f7"
  }
  if (order.direction === "buy") {
    return "#ef4444"
  }
  return "#22c55e"
}

function orderKey(orders: PaperOrderItem[]): string {
  return orders
    .map((o) => `${o.id}:${o.price}:${o.quantity}:${o.status}`)
    .sort()
    .join("|")
}

/** 同步 pending 限价单到蜡烛图 price line */
export function useOrderPriceLines(props: {
  seriesRef: MutableRefObject<ISeriesApi<"Candlestick"> | null>
  pendingOrders: PaperOrderItem[]
  activeContract: string
  chartReady: number
  seriesReady: number
}): void {
  const { seriesRef, pendingOrders, activeContract, chartReady, seriesReady } =
    props
  const key = orderKey(pendingOrders)

  useEffect(() => {
    // 等 chart 与 candle series 都就绪
    if (chartReady === 0) return

    const draw = (): IPriceLine[] => {
      const series = seriesRef.current
      if (!series) return []
      const lines: IPriceLine[] = []
      const symbol = activeContract.toLowerCase()
      const orders = pendingOrders.filter(
        (o) =>
          o.status === "pending" &&
          o.order_type === "limit" &&
          o.symbol.toLowerCase() === symbol
      )
      for (const order of orders) {
        try {
          lines.push(
            series.createPriceLine({
              price: order.price,
              color: lineColor(order),
              lineWidth: 1,
              lineStyle: 2,
              axisLabelVisible: true,
              title: lineTitle(order),
            })
          )
        } catch {
          // series 未就绪
        }
      }
      return lines
    }

    let lines = draw()
    // series 可能刚清空，下一帧再画一次
    let raf = 0
    if (lines.length === 0 && pendingOrders.length > 0) {
      raf = requestAnimationFrame(() => {
        lines = draw()
      })
    }

    return () => {
      if (raf) cancelAnimationFrame(raf)
      const s = seriesRef.current
      if (!s) return
      for (const line of lines) {
        try {
          s.removePriceLine(line)
        } catch {
          // ignore
        }
      }
    }
    // key 代替 pendingOrders 引用，避免无意义重绘
  }, [
    seriesRef,
    key,
    pendingOrders,
    activeContract,
    chartReady,
    seriesReady,
  ])
}
