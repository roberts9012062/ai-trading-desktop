"use client"

/**
 * 在 K 线主图上绘制持仓成本线（虚线）
 *
 * 做多红 / 做空绿；标题含开仓价 + 浮动盈亏（实时随行情刷新）
 * 行情页与交易页共用同一 KlineChart，切换到有持仓的品种即显示。
 */

import { useEffect, type MutableRefObject } from "react"
import type { IPriceLine, ISeriesApi } from "lightweight-charts"
import type { PaperPositionItem } from "@/lib/paper-api"

function fmtPrice(price: number): string {
  if (!Number.isFinite(price)) return "--"
  const abs = Math.abs(price)
  if (abs >= 1000) return price.toFixed(0)
  if (abs >= 10) return price.toFixed(1)
  if (abs >= 1) return price.toFixed(2)
  if (abs >= 0.01) return price.toFixed(4)
  if (abs >= 0.0001) return price.toFixed(6)
  return price.toFixed(8)
}

function fmtPnl(pnl: number): string {
  if (!Number.isFinite(pnl)) return "盈亏--"
  const abs = Math.abs(pnl)
  const body = abs >= 100 ? abs.toFixed(0) : abs.toFixed(2)
  if (pnl > 0) return `盈+${body}`
  if (pnl < 0) return `亏-${body}`
  return "盈亏0"
}

/** 持仓浮盈：多 (现价-均价)*量*乘数；空 (均价-现价)*量*乘数 */
export function calcPositionPnl(
  pos: PaperPositionItem,
  lastPrice: number
): number {
  if (!lastPrice || lastPrice <= 0) return NaN
  const mult = pos.multiplier > 0 ? pos.multiplier : 10
  if (pos.direction === "long") {
    return (lastPrice - pos.avg_price) * pos.quantity * mult
  }
  return (pos.avg_price - lastPrice) * pos.quantity * mult
}

function lineTitle(pos: PaperPositionItem, lastPrice: number): string {
  const side = pos.direction === "long" ? "做多" : "做空"
  const pnl = calcPositionPnl(pos, lastPrice)
  return `${side} ${pos.quantity}手 @${fmtPrice(pos.avg_price)} ${fmtPnl(pnl)}`
}

/** 做多红 / 做空绿（国内期货习惯） */
function lineColor(direction: string): string {
  if (direction === "short") return "#22c55e"
  return "#ef4444"
}

function positionKey(
  positions: PaperPositionItem[],
  lastPrice: number
): string {
  // 价格变化时刷新标题上的盈亏；取整到 0.5 避免每 tick 狂刷
  const pxBucket = Math.round(lastPrice * 2) / 2
  return (
    positions
      .map(
        (p) =>
          `${p.id}:${p.avg_price}:${p.quantity}:${p.direction}:${p.multiplier}`
      )
      .sort()
      .join("|") + `|lp:${pxBucket}`
  )
}

/** 同步当前合约持仓成本线到蜡烛图 */
export function usePositionPriceLines(props: {
  seriesRef: MutableRefObject<ISeriesApi<"Candlestick"> | null>
  positions: PaperPositionItem[]
  activeContract: string
  /** 最新价，用于浮盈 */
  lastPrice: number
  chartReady: number
  seriesReady: number
}): void {
  const {
    seriesRef,
    positions,
    activeContract,
    lastPrice,
    chartReady,
    seriesReady,
  } = props
  const symbol = activeContract.toLowerCase()
  const mine = positions.filter(
    (p) => p.quantity > 0 && p.symbol.toLowerCase() === symbol
  )
  const key = positionKey(mine, lastPrice)
  const hasMine = mine.length > 0

  useEffect(() => {
    if (chartReady === 0) return
    const symbolNow = activeContract.toLowerCase()
    const list = positions.filter(
      (p) => p.quantity > 0 && p.symbol.toLowerCase() === symbolNow
    )

    const draw = (): IPriceLine[] => {
      const series = seriesRef.current
      if (!series) return []
      const lines: IPriceLine[] = []
      for (const pos of list) {
        if (!pos.avg_price || pos.avg_price <= 0) continue
        try {
          lines.push(
            series.createPriceLine({
              price: pos.avg_price,
              color: lineColor(pos.direction),
              lineWidth: 2,
              lineStyle: 2, // 虚线
              axisLabelVisible: true,
              title: lineTitle(pos, lastPrice),
            })
          )
        } catch {
          // series 未就绪
        }
      }
      return lines
    }

    let lines = draw()
    let raf = 0
    if (lines.length === 0 && list.length > 0) {
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
    // key 编码持仓+价格桶；hasMine 仅作空态提示
  }, [
    seriesRef,
    key,
    hasMine,
    positions,
    activeContract,
    lastPrice,
    chartReady,
    seriesReady,
  ])
}
