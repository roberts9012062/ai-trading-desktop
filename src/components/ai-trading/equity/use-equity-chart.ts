/**
 * 收益图：生命周期 + 序列更新 + 徽章 + hover 高亮
 */
import {
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react"
import {
  ColorType,
  CrosshairMode,
  createChart,
  LineSeries,
  LineType,
  type IChartApi,
  type ISeriesApi,
  type LineData,
  type Time,
} from "lightweight-charts"
import type { AITradingTask, EquityPoint } from "@/lib/ai-trading-api"
import { resolveSeriesColor } from "@/lib/provider-avatar"
import type { EndBadgeLayout } from "./equity-end-badges"
import { scheduleBadgeLayout } from "./equity-badge-layout"
import { lineForTradeSession } from "./equity-data"
import {
  getTradeSessionRange,
  type EquityAxisMode,
} from "./equity-session"
import {
  crosshairTimeFormatter,
  tickMarkFormatter,
} from "./equity-time"

const CHART_HEIGHT = 340

function hexToRgba(hex: string, alpha: number): string {
  const raw = hex.replace("#", "")
  if (raw.length !== 6) return `rgba(148,163,184,${alpha})`
  const r = Number.parseInt(raw.slice(0, 2), 16)
  const g = Number.parseInt(raw.slice(2, 4), 16)
  const b = Number.parseInt(raw.slice(4, 6), 16)
  return `rgba(${r},${g},${b},${alpha})`
}

export function useEquityChart(props: {
  containerRef: RefObject<HTMLDivElement | null>
  tasks: AITradingTask[]
  series: Record<string, EquityPoint[]>
  lastValues: Map<string, number>
  leaderId: string | null
  /** 底部卡片 hover 的任务 id */
  highlightTaskId: string | null
  /** live=交易日轴 / virtual=近24h墙钟 */
  axisMode: EquityAxisMode
}): { badges: EndBadgeLayout[]; chartWidth: number; chartHeight: number } {
  const {
    containerRef,
    tasks,
    series,
    lastValues,
    leaderId,
    highlightTaskId,
    axisMode,
  } = props
  const chartRef = useRef<IChartApi | null>(null)
  const seriesMapRef = useRef<Map<string, ISeriesApi<"Line">>>(new Map())
  const colorMapRef = useRef<Map<string, string>>(new Map())
  const anchorRef = useRef<ISeriesApi<"Line"> | null>(null)
  const zeroLineRef = useRef<ReturnType<
    ISeriesApi<"Line">["createPriceLine"]
  > | null>(null)
  const tasksRef = useRef(tasks)
  tasksRef.current = tasks
  const highlightRef = useRef(highlightTaskId)
  highlightRef.current = highlightTaskId
  const axisModeRef = useRef(axisMode)
  axisModeRef.current = axisMode
  const [badges, setBadges] = useState<EndBadgeLayout[]>([])
  const [chartWidth, setChartWidth] = useState(0)

  useEffect(() => {
    if (!containerRef.current) return
    const chart = createChart(containerRef.current, {
      height: CHART_HEIGHT,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: "rgba(156,163,175,0.9)",
        fontSize: 11,
        fontFamily: "ui-sans-serif, system-ui, sans-serif",
      },
      localization: {
        locale: "zh-CN",
        timeFormatter: crosshairTimeFormatter,
      },
      grid: {
        vertLines: { color: "rgba(255,255,255,0.03)", style: 1 },
        horzLines: { color: "rgba(255,255,255,0.05)", style: 1 },
      },
      rightPriceScale: {
        borderVisible: false,
        scaleMargins: { top: 0.12, bottom: 0.14 },
        entireTextOnly: true,
        // 保证数值越大越靠上，亏损越大越靠下
        invertScale: false,
      },
      leftPriceScale: { visible: false },
      timeScale: {
        borderVisible: false,
        timeVisible: true,
        secondsVisible: false,
        // 右侧留白，末端徽章/端点不顶住价格轴
        rightOffset: 8,
        fixLeftEdge: true,
        fixRightEdge: true,
        lockVisibleTimeRangeOnResize: true,
        minBarSpacing: 0.01,
        tickMarkFormatter,
      },
      crosshair: {
        mode: CrosshairMode.Magnet,
        vertLine: {
          color: "rgba(148,163,184,0.35)",
          width: 1,
          style: 2,
          labelBackgroundColor: "rgba(30,41,59,0.95)",
        },
        horzLine: {
          color: "rgba(148,163,184,0.25)",
          width: 1,
          style: 2,
          labelBackgroundColor: "rgba(30,41,59,0.95)",
        },
      },
      handleScroll: { mouseWheel: false, pressedMouseMove: false },
      handleScale: {
        axisPressedMouseMove: false,
        mouseWheel: false,
        pinch: false,
      },
    })
    chartRef.current = chart
    setChartWidth(containerRef.current.clientWidth)

    const layout = () =>
      scheduleBadgeLayout(
        chartRef,
        seriesMapRef,
        tasksRef,
        setBadges,
        axisModeRef.current,
      )

    const ro = new ResizeObserver(() => {
      if (!containerRef.current || !chartRef.current) return
      const w = containerRef.current.clientWidth
      chartRef.current.applyOptions({ width: w })
      setChartWidth(w)
      layout()
    })
    ro.observe(containerRef.current)
    chart.timeScale().subscribeVisibleLogicalRangeChange(layout)

    return () => {
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(layout)
      ro.disconnect()
      chart.remove()
      chartRef.current = null
      seriesMapRef.current.clear()
      colorMapRef.current.clear()
      anchorRef.current = null
      zeroLineRef.current = null
    }
  }, [containerRef])

  useEffect(() => {
    const chart = chartRef.current
    if (!chart) return

    const activeIds = new Set(tasks.map((t) => t.id))
    for (const [id, s] of seriesMapRef.current) {
      if (!activeIds.has(id)) {
        chart.removeSeries(s)
        seriesMapRef.current.delete(id)
        colorMapRef.current.delete(id)
      }
    }

    const firstLines: ISeriesApi<"Line">[] = []
    const session = getTradeSessionRange(Date.now(), axisMode)
    const hoverId = highlightTaskId

    if (!anchorRef.current) {
      anchorRef.current = chart.addSeries(LineSeries, {
        color: "rgba(0,0,0,0)",
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
        pointMarkersVisible: false,
      })
    }
    const anchorPts: LineData[] = []
    // virtual 日轴 00–24 用 15 分钟锚点（与 live 一致，撑满全天）
    const step = 15 * 60
    for (let t = session.fromSec; t <= session.toSec; t += step) {
      anchorPts.push({ time: t as Time, value: 0 })
    }
    if (anchorPts[anchorPts.length - 1]?.time !== (session.toSec as Time)) {
      anchorPts.push({ time: session.toSec as Time, value: 0 })
    }
    anchorRef.current.setData(anchorPts)

    tasks.forEach((task, idx) => {
      const color = resolveSeriesColor(
        task.model_id,
        task.provider_name,
        task.model_display_name,
        idx,
      )
      colorMapRef.current.set(task.id, color)
      const isLeader = leaderId === task.id
      const isHighlight = hoverId != null && hoverId === task.id
      const isDimmed = hoverId != null && hoverId !== task.id

      // 高亮加粗；其余压暗半透明。不用贝塞尔，避免过冲造成「亏了还往上」
      const lineColor = isDimmed ? hexToRgba(color, 0.18) : color
      const lineWidth = isHighlight ? 4 : isLeader ? 3 : 2

      let line = seriesMapRef.current.get(task.id)
      if (!line) {
        line = chart.addSeries(LineSeries, {
          color: lineColor,
          lineWidth,
          // Simple：Y 严格等于数据点，杜绝曲线过冲
          lineType: LineType.Simple,
          priceLineVisible: false,
          lastValueVisible: false,
          crosshairMarkerVisible: !isDimmed,
          crosshairMarkerRadius: isHighlight ? 6 : 5,
          crosshairMarkerBorderWidth: 2,
          crosshairMarkerBorderColor: "#0f1115",
          crosshairMarkerBackgroundColor: color,
          pointMarkersVisible: false,
        })
        seriesMapRef.current.set(task.id, line)
      } else {
        line.applyOptions({
          color: lineColor,
          lineWidth,
          lineType: LineType.Simple,
          crosshairMarkerVisible: !isDimmed,
          crosshairMarkerRadius: isHighlight ? 6 : 5,
          crosshairMarkerBackgroundColor: color,
        })
      }
      if (firstLines.length === 0) firstLines.push(line)

      const pts = series[task.id] ?? []
      const dedup = lineForTradeSession(
        task,
        pts,
        lastValues.get(task.id) ?? 0,
        Date.now(),
        axisMode,
      )
      line.setData(dedup)
    })

    // hover 时把高亮序列移到最前（后添加的在上层）
    if (hoverId && seriesMapRef.current.has(hoverId)) {
      const hi = seriesMapRef.current.get(hoverId)!
      // lightweight-charts v5：通过 applyOptions 视觉突出即可
      hi.applyOptions({ lineWidth: 4 })
    }

    const firstLine = firstLines[0]
    if (firstLine) {
      if (zeroLineRef.current) {
        try {
          firstLine.removePriceLine(zeroLineRef.current)
        } catch {
          /* ignore */
        }
        zeroLineRef.current = null
      }
      zeroLineRef.current = firstLine.createPriceLine({
        price: 0,
        color: "rgba(148,163,184,0.45)",
        lineWidth: 1,
        lineStyle: 2,
        axisLabelVisible: true,
        title: "0",
      })
    }

    const applyRange = () => {
      try {
        chart.timeScale().setVisibleRange({
          from: session.fromSec as Time,
          to: session.toSec as Time,
        })
      } catch {
        /* ignore */
      }
    }
    applyRange()
    requestAnimationFrame(applyRange)
    setTimeout(applyRange, 80)
    setTimeout(
      () => scheduleBadgeLayout(chartRef, seriesMapRef, tasksRef, setBadges, axisMode),
      0,
    )
  }, [tasks, series, lastValues, leaderId, highlightTaskId, axisMode])

  return { badges, chartWidth, chartHeight: CHART_HEIGHT }
}
