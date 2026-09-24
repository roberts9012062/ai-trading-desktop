"use client"

/**
 * K 线悬停浮空面板：crosshair 订阅 + rAF 节流
 */

import { useEffect, useRef, useState, type RefObject } from "react"
import type { IChartApi, MouseEventParams, Time } from "lightweight-charts"
import { useAppStore } from "@/stores/app"
import { useMarketStore } from "@/stores/market"
import type { KlineBar, KlinePeriod } from "@/types"
import type { HoverPanelPosition, HoverPanelState } from "../kline-hover-info-panel"
import { normalizeBarTime } from "./utils"

const INITIAL_HOVER: HoverPanelState = {
  barIndex: null,
  position: "right",
  visible: false,
}

/** 订阅 crosshair，返回悬停状态
 *
 * chartReady 在主图 createChart 完成后递增，确保本 effect 晚于图表初始化。
 */
export function useHoverPanel(props: {
  chartRef: RefObject<IChartApi | null>
  containerRef: RefObject<HTMLDivElement | null>
  barsRef: RefObject<KlineBar[]>
  period: KlinePeriod
  chartReady: number
}): HoverPanelState {
  const [hoverState, setHoverState] = useState<HoverPanelState>(INITIAL_HOVER)
  const hoverRafRef = useRef<number | null>(null)
  const pendingHoverRef = useRef<HoverPanelState | null>(null)

  useEffect(() => {
    if (props.chartReady === 0) return
    const chart = props.chartRef.current
    const container = props.containerRef.current
    if (!chart || !container) return

    const scheduleFlush = (): void => {
      if (hoverRafRef.current !== null) return
      hoverRafRef.current = requestAnimationFrame(() => {
        hoverRafRef.current = null
        const pending = pendingHoverRef.current
        if (pending) {
          pendingHoverRef.current = null
          setHoverState(pending)
        }
      })
    }

    const calcPosition = (clientX: number): HoverPanelPosition => {
      const rect = container.getBoundingClientRect()
      const relX = clientX - rect.left
      const halfWidth = chart.timeScale().width() / 2
      return relX > halfWidth ? "left" : "right"
    }

    const isRealtimeNewBar = (): boolean => {
      const bars = props.barsRef.current
      if (bars.length === 0) return false
      const symbol = useAppStore.getState().activeContract
      const rt = useMarketStore.getState().klineRealtime[symbol]?.[props.period as KlinePeriod]
      if (!rt) return false
      return normalizeBarTime(props.period, rt.time) > normalizeBarTime(props.period, bars[bars.length - 1].time)
    }

    const pickBarIndex = (logical: number | undefined): number | null => {
      const bars = props.barsRef.current
      if (bars.length === 0) return null
      const maxIdx = isRealtimeNewBar() ? bars.length : bars.length - 1
      if (logical === undefined || Number.isNaN(logical)) {
        return maxIdx
      }
      const idx = Math.floor(logical)
      if (idx < 0) return 0
      if (idx > maxIdx) return maxIdx
      return idx
    }

    const handler = (param: MouseEventParams<Time>): void => {
      if (props.period === "tick") {
        if (pendingHoverRef.current?.visible !== false) {
          pendingHoverRef.current = { barIndex: null, position: "right", visible: false }
          scheduleFlush()
        }
        return
      }

      if (props.barsRef.current.length === 0) {
        if (pendingHoverRef.current?.visible !== false) {
          pendingHoverRef.current = { barIndex: null, position: "right", visible: false }
          scheduleFlush()
        }
        return
      }

      const clientX = param.sourceEvent?.clientX
      // 鼠标离开图表：保持上次面板（不自动消失）
      if (clientX === undefined || param.point === undefined) {
        return
      }

      const barIndex = pickBarIndex(param.logical)
      if (barIndex === null) return

      const next: HoverPanelState = {
        barIndex,
        position: calcPosition(clientX),
        visible: true,
      }
      const prev = pendingHoverRef.current
      if (
        !prev ||
        prev.visible !== next.visible ||
        prev.position !== next.position ||
        prev.barIndex !== next.barIndex
      ) {
        pendingHoverRef.current = next
        scheduleFlush()
      }
    }

    chart.subscribeCrosshairMove(handler)
    return () => {
      chart.unsubscribeCrosshairMove(handler)
      if (hoverRafRef.current !== null) {
        cancelAnimationFrame(hoverRafRef.current)
        hoverRafRef.current = null
      }
      pendingHoverRef.current = null
    }
  }, [props.chartRef, props.containerRef, props.barsRef, props.period, props.chartReady])

  return hoverState
}
