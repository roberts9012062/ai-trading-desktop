"use client"

/**
 * K 线图主组件：组装历史 / 悬停 / series / 实时更新
 */

import { useRef, useEffect, useState, useCallback, useMemo } from "react"
import {
  createChart,
  LineStyle,
  type IChartApi,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type Time,
} from "lightweight-charts"
import { cn } from "@/lib/utils"
import { useAppStore } from "@/stores/app"
import { useIndicatorStore } from "@/stores/indicator"
import { useBacktestIndicatorStore } from "@/stores/backtest-indicator"
import { useAiMarketIndicatorStore } from "@/stores/ai-market-indicator"
import { useAuthStore } from "@/stores/auth"
import { useMarketStore } from "@/stores/market"
import { useContractSpecStore } from "@/stores/contract-spec"
import type { KlineBar, KlinePeriod } from "@/types"
import { IndicatorSettingsDialog } from "../indicator-settings-dialog"
import { PERIODS, formatChartTime, makeChartOpts, resolveHoveredBar } from "./utils"
import { NextBarCountdown } from "./next-bar-countdown"
import { useHoverPanel } from "./use-hover-panel"
import { useKlineHistory, forceRefetchKline } from "./use-kline-history"
import { useChartSeries } from "./use-chart-series"
import { useRealtimeKline } from "./use-realtime-kline"
import { useIntradayChart } from "./use-intraday-chart"
import type {
  SubIndicatorHandle,
  SubIndicatorId,
} from "./indicators/registry"
import { useTradeLines } from "./lines/use-trade-lines"
import { useForecastLines } from "./lines/use-forecast-lines"
import type { AITradingTask } from "@/lib/ai-trading-api"
import { setCurrentKlinePeriod } from "./current-period"
import { prefetchKlineHistory } from "./use-kline-history"
import { KlineHoverBookPanel } from "./hover-book-panel"
import { useDrawingOverlay } from "./drawing/use-drawing-overlay"
import { DrawingToolbar } from "./drawing/DrawingToolbar"
import type { IndicatorStoreHook } from "@/types/indicator"
import type { TaskTradeMark } from "@/lib/ai-trading-api"
import {
  applyTradeMarks,
  buildBarMarksIndex,
  buildTickTradeMarkers,
  buildTradeMarkers,
  clearTradeMarks,
  summarizeGroup,
  type TradeMarksController,
} from "./trade-marks"

/** 分时模式下分时数据逐秒增长（ref 变更不触发渲染），标记定时重对齐 */
const TICK_MARKS_REALIGN_MS = 2000

/**
 * 图表价格精度：行情携带的规格小数位优先（交易所 tick 权威），
 * 缺省按最新价量级自适应（r20 symbolPrecision 阶梯扩展至微价格币）。
 * 加密货币单位差异大（BTC 1 位 / PEPE 9 位），不能统一标准。
 */
function chartPrecision(decimals: number | undefined, lastClose: number | undefined): number {
  if (decimals != null && decimals >= 0 && decimals <= 10) return decimals
  const p = Number(lastClose) || 0
  if (p >= 10000) return 1
  if (p >= 100) return 2
  if (p >= 1) return 3
  if (p >= 0.1) return 4
  if (p >= 0.01) return 5
  if (p >= 0.001) return 6
  if (p >= 0.0001) return 7
  if (p >= 0.00001) return 8
  return p > 0 ? 9 : 2
}

export interface KlineChartProps {
  forecastTasks?: AITradingTask[]
  /** 任务 K 线交易标记（AI 看盘页传入；不传则无标记，行为同行情页） */
  tradeMarks?: TaskTradeMark[]
  /**
   * 用户挂单/持仓价格线：all=全部来源（行情/交易/AI 看盘页）；
   * manual=仅手动单；off=关闭
   */
  userTradeLines?: "all" | "manual" | "off"
  /** 指标配置 store（AI 看盘页传 useAiMarketIndicatorStore，指标设置与行情页隔离） */
  indicatorStore?: IndicatorStoreHook
  /** 是否把当前周期写入全局单例（合约列表预取用）；分屏 2-4 传 false 防止互相覆盖 */
  syncGlobalPeriod?: boolean
  /** 紧凑模式：分屏时工具条换行、按钮收紧，适配窄宽度分屏 */
  compact?: boolean
}

/** K 线图组件（含均线叠加 + MACD 副图 + 实时更新） */
export function KlineChart({
  forecastTasks = [],
  tradeMarks,
  userTradeLines = "all",
  indicatorStore = useIndicatorStore as IndicatorStoreHook,
  syncGlobalPeriod = true,
  compact = false,
}: KlineChartProps): React.JSX.Element {
  const mainRef = useRef<HTMLDivElement>(null)
  const mainApiRef = useRef<IChartApi | null>(null)
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null)
  const tickSeriesRef = useRef<ISeriesApi<"Line"> | null>(null)
  const volumeRef = useRef<ISeriesApi<"Histogram"> | null>(null)
  const maSeriesRef = useRef<ISeriesApi<"Line">[]>([])
  const bollSeriesRef = useRef<
    [ISeriesApi<"Line"> | null, ISeriesApi<"Line"> | null, ISeriesApi<"Line"> | null]
  >([null, null, null])
  // 副图指标（MACD/RSI/JDK/强弱）全部图元：id → 注册表 handle
  const subHandlesRef = useRef<Map<SubIndicatorId, SubIndicatorHandle>>(new Map())
  const pivotMarkersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null)
  const tradeMarksCtlRef = useRef<TradeMarksController | null>(null)
  const isNearLatest = useRef(true)
  const lastRealtimeTime = useRef<string | null>(null)
  const scrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const loadingMoreRef = useRef(false)
  const lastLoadedEndTimeRef = useRef<string | null>(null)
  const skipScrollRef = useRef(false)
  const prevBarsCountRef = useRef(0)
  const savedRangeRef = useRef<{ from: number; to: number } | null>(null)
  const currentBarsRef = useRef<KlineBar[]>([])
  const loadMoreRef = useRef<(symbol: string, p: KlinePeriod) => void>(() => {})
  const hasMoreRef = useRef(true)
  const tickDataRef = useRef<{ time: number; value: number }[]>([])

  const { activeContract } = useAppStore()
  const orderPricePreview = useAppStore((s) => s.orderPricePreview)
  const activeOrderbook = useMarketStore((s) => s.orderbooks[activeContract])
  const activeQuote = useMarketStore((s) => s.quotes[activeContract])
  const quoteDecimals = activeQuote?.decimal_places
  const { config } = (indicatorStore as typeof useIndicatorStore)()
  const klineRealtime = useMarketStore((s) => s.klineRealtime)
  const [period, setPeriod] = useState<KlinePeriod>("1d")
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [maLabels, setMaLabels] = useState<string[]>([])
  const [chartReady, setChartReady] = useState(0)
  /** 蜡烛 series 重建计数，驱动挂单/持仓线重绘 */
  const [seriesReady, setSeriesReady] = useState(0)
  /** 十字线悬浮盘口面板位置（null=隐藏：鼠标离开图表/未接触 K 线） */
  const [hoverPanel, setHoverPanel] = useState<{ x: number; y: number } | null>(null)
  const macdEnabled = config.macd.enabled
  const rsiEnabled = config.rsi.enabled
  const bollEnabled = config.boll.enabled
  const jdkEnabled = config.jdk.enabled
  const strengthEnabled = config.strength.enabled && config.strengthVersion === "v1"
  const strengthV2Enabled = config.strengthV2.enabled && config.strengthVersion === "v2"
  const pivotEnabled = config.pivot?.enabled ?? false

  // 稳定回调，避免 useChartSeries effect 因函数引用变化死循环
  const handleSeriesReady = useCallback(() => {
    setSeriesReady((n) => n + 1)
  }, [])

  // 实时尾段缺根自愈：单周期 force 重拉补全已收盘 bar（波段右侧确认依赖序列完整）
  const handleRtGap = useCallback(() => {
    forceRefetchKline(activeContract, period)
  }, [activeContract, period])

  const { loadMoreHistory, isLoading, hasMore, currentBars } = useKlineHistory({
    activeContract,
    period,
    mainApiRef,
    loadingMoreRef,
    lastLoadedEndTimeRef,
    skipScrollRef,
    prevBarsCountRef,
    savedRangeRef,
    scrollTimerRef,
  })
  currentBarsRef.current = currentBars

  // 同步当前周期，供列表点击/预取使用（分屏 2-4 不同步，避免覆盖分屏 1）
  useEffect(() => {
    if (!syncGlobalPeriod) return
    setCurrentKlinePeriod(period)
  }, [period, syncGlobalPeriod])

  // K 线 WS 订阅：登记当前合约（引用计数，多分屏自动取并集）；
  // 服务端只推订阅合约的 forming bar，切换合约即重订，重连自动重发
  useEffect(() => {
    if (!activeContract) return
    const market = useMarketStore.getState()
    market.watchKlineSymbol(activeContract)
    return () => {
      useMarketStore.getState().unwatchKlineSymbol(activeContract)
    }
  }, [activeContract])

  // 登录后从后端加载指标配置（token 变化时重新拉取；内部自带 loaded 去重）。
  // 仅全局行情 store 有服务端同步；隔离 store（AI 看盘）为纯本地，跳过。
  const accessToken = useAuthStore((s) => s.accessToken)
  useEffect(() => {
    if (indicatorStore !== useIndicatorStore) return
    void useIndicatorStore.getState().loadFromServer()
  }, [accessToken, indicatorStore])

  // 登录后加载品种规格（提供 tick_size / decimal_places 用于画线吸附与价格精度）
  useEffect(() => {
    void useContractSpecStore.getState().load()
  }, [accessToken])

  // 当前合约的价格小数位（传给悬停面板按品种精度显示）
  const decimalPlaces = useContractSpecStore((s) => s.getDecimalPlaces(activeContract))

  const hoverState = useHoverPanel({
    chartRef: mainApiRef,
    containerRef: mainRef,
    barsRef: currentBarsRef,
    period,
    chartReady,
  })

  useEffect(() => {
    if (!mainRef.current) return
    const chart = createChart(mainRef.current, makeChartOpts())
    mainApiRef.current = chart
    setChartReady((n) => n + 1)
    // 悬浮盘口：十字线在 K 线上移动时跟随光标；离开/未命中蜡烛即隐藏
    chart.subscribeCrosshairMove((param) => {
      if (param.point && (param.time !== undefined || param.seriesData.size > 0)) {
        setHoverPanel({ x: param.point.x, y: param.point.y })
      } else {
        setHoverPanel(null)
      }
    })
    const ro = new ResizeObserver(([e]) => {
      chart.applyOptions({ width: e.contentRect.width, height: e.contentRect.height })
    })
    ro.observe(mainRef.current)
    return () => {
      ro.disconnect()
      chart.remove()
      mainApiRef.current = null
      seriesRef.current = null
      tickSeriesRef.current = null
      volumeRef.current = null
      maSeriesRef.current = []
    }
  }, [])

  useChartSeries({
    mainApiRef,
    seriesRef,
    tickSeriesRef,
    volumeRef,
    maSeriesRef,
    bollSeriesRef,
    subHandlesRef,
    pivotMarkersRef,
    currentBarsRef,
    currentBars,
    period,
    activeContract,
    config,
    isNearLatest,
    lastRealtimeTime,
    scrollTimerRef,
    skipScrollRef,
    prevBarsCountRef,
    savedRangeRef,
    setMaLabels,
    chartReady,
    onSeriesReady: handleSeriesReady,
  })

  hasMoreRef.current = hasMore
  loadMoreRef.current = loadMoreHistory

  useEffect(() => {
    if (chartReady === 0) return
    const chart = mainApiRef.current
    if (!chart || period === "tick") return
    const handler = (range: { from: number; to: number } | null) => {
      if (!range) return
      const barsLen = currentBarsRef.current.length
      // 贴最新：to 到达/越过最后一根（右侧空白时 to > last）
      // 用户左拖看历史时 to 明显小于 last
      if (barsLen > 0) {
        const last = barsLen - 1
        const visible = Math.max(1, range.to - range.from)
        isNearLatest.current = range.to >= last - visible * 0.15
      }
      // 贴最新时绝不懒加载：否则 prepend + 视口回拉会冲掉「半空」布局
      if (isNearLatest.current) return
      const visibleBars = range.to - range.from
      const threshold = Math.min(100, Math.max(40, Math.floor(visibleBars * 0.8)))
      if (range.from <= threshold && hasMoreRef.current && !loadingMoreRef.current) {
        loadMoreRef.current(activeContract, period)
      }
    }
    chart.timeScale().subscribeVisibleLogicalRangeChange(handler)
    return () => { chart?.timeScale().unsubscribeVisibleLogicalRangeChange(handler) }
  }, [activeContract, period, chartReady])

  useRealtimeKline({
    seriesRef,
    volumeRef,
    tickSeriesRef,
    maSeriesRef,
    bollSeriesRef,
    subHandlesRef,
    pivotMarkersRef,
    mainApiRef,
    currentBars,
    period,
    activeContract,
    config,
    isNearLatest,
    lastRealtimeTime,
    tickDataRef,
    onRtGap: handleRtGap,
  })

  const intradayStatus = useIntradayChart({ symbol: activeContract, enabled: period === "tick", seriesReady, chart: mainApiRef, series: tickSeriesRef, points: tickDataRef })

  useTradeLines({
    seriesRef,
    activeContract,
    chartReady,
    seriesReady,
    enabled: userTradeLines !== "off",
    source: userTradeLines === "manual" ? "manual" : "all",
  })
  useForecastLines({seriesRef,tasks:forecastTasks,symbol:activeContract,ready:chartReady+seriesReady})

  // 任务交易标记（AI 看盘页）：
  // - 蜡烛周期：吸附到当前周期 bar，任务/周期/历史变化时重建
  // - 分时：吸附到分时数据点（无历史 bar，数据逐秒增长需定时重对齐）
  useEffect(() => {
    if (tradeMarks === undefined) return // 行情页：不挂插件

    if (period === "tick") {
      const applyTick = () => {
        const series = tickSeriesRef.current
        const times = tickDataRef.current.map((p) => p.time)
        if (!series || times.length === 0) {
          clearTradeMarks(tradeMarksCtlRef)
          return
        }
        applyTradeMarks(
          series,
          tradeMarksCtlRef,
          buildTickTradeMarkers(tradeMarks, times),
        )
      }
      applyTick()
      const timer = setInterval(applyTick, TICK_MARKS_REALIGN_MS)
      return () => {
        clearInterval(timer)
        clearTradeMarks(tradeMarksCtlRef)
      }
    }

    if (!seriesRef.current || currentBars.length === 0) {
      clearTradeMarks(tradeMarksCtlRef)
      return
    }
    const markers = buildTradeMarkers(tradeMarks, currentBars, period)
    applyTradeMarks(seriesRef.current, tradeMarksCtlRef, markers)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tradeMarks, currentBars, period, seriesReady, chartReady, activeContract])

  // 卸载时清理标记插件
  useEffect(() => {
    return () => clearTradeMarks(tradeMarksCtlRef)
  }, [])

  // 指定价虚线预览：限价手动模式时在下单目标合约的图上画虚线（上下拨动即时移动）
  const preview = orderPricePreview
  const previewValid =
    preview !== null &&
    preview.symbol === activeContract &&
    preview.price > 0
  useEffect(() => {
    const series = seriesRef.current
    if (!series || !previewValid || !preview) return
    const line = series.createPriceLine({
      price: preview.price,
      color: preview.direction === "buy" ? "#ef4444" : "#22c55e",
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      axisLabelVisible: true,
      title: `委托${preview.direction === "buy" ? "买" : "卖"}`,
    })
    return () => {
      try {
        series.removePriceLine(line)
      } catch {
        // series 已销毁
      }
    }
  }, [preview, previewValid, seriesReady, activeContract])

  // 价格精度自适应：规格小数位（或量级兜底）应用到蜡烛/均线/BOLL/成交量轴
  const lastCloseForPrec = currentBarsRef.current[currentBarsRef.current.length - 1]?.close
  const prec = chartPrecision(quoteDecimals, lastCloseForPrec)
  useEffect(() => {
    const series = seriesRef.current
    if (!series) return
    const minMove = Number((10 ** -prec).toFixed(prec))
    series.applyOptions({
      priceFormat: { type: "price", precision: prec, minMove },
    })
    for (const s of maSeriesRef.current) {
      s?.applyOptions({ priceFormat: { type: "price", precision: prec, minMove } })
    }
    for (const s of bollSeriesRef.current) {
      s?.applyOptions({ priceFormat: { type: "price", precision: prec, minMove } })
    }
    volumeRef.current?.applyOptions({
      priceFormat: { type: "volume", precision: 2, minMove: 0.01 },
    })
  }, [prec, seriesReady, activeContract])

  // K 线画图层（双击切出工具栏；不影响 K 线渲染与走势）
  useDrawingOverlay({
    chartRef: mainApiRef,
    seriesRef,
    containerRef: mainRef,
    symbol: activeContract,
    period,
    chartReady,
    seriesReady,
  })

  const maCount = config.maLines.length
  const hoveredBar = resolveHoveredBar(
    hoverState.barIndex,
    currentBars,
    klineRealtime[activeContract]?.[period as KlinePeriod],
    period,
  )
  // 悬停 bar 的任务成交明细（AI 看盘页）：图上标记保持精简，
  // 手数/价格等细节放进十字线信息面板
  const barMarksIndex = useMemo(
    () =>
      tradeMarks !== undefined && period !== "tick"
        ? buildBarMarksIndex(tradeMarks, currentBars, period)
        : null,
    [tradeMarks, currentBars, period],
  )
  const hoveredTradeRows = useMemo(() => {
    if (!barMarksIndex || !hoveredBar) return undefined
    return summarizeGroup(
      barMarksIndex.get(String(formatChartTime(period, hoveredBar.time))),
    )
  }, [barMarksIndex, hoveredBar, period])
  const indicatorHint = [
    maCount > 0 ? `MA×${maCount}` : "",
    bollEnabled ? "BOLL" : "",
    macdEnabled ? "MACD" : "",
    rsiEnabled ? "RSI" : "",
    jdkEnabled ? "JDK" : "",
    strengthEnabled ? "强弱" : "",
    strengthV2Enabled ? "强弱V2" : "",
    pivotEnabled ? "波段" : "",
  ]
    .filter(Boolean)
    .join(" ")

  return (
    <div className="flex flex-col h-full">
      <div
        className={cn(
          "flex items-center gap-1 border-b border-[var(--border)] bg-[var(--bg-secondary)]",
          compact ? "flex-wrap gap-y-0.5 px-1 py-1" : "px-2 py-1.5",
        )}
      >
        {PERIODS.map((p) => (
          <button
            key={p.value}
            onClick={() => setPeriod(p.value)}
            className={cn(
              "rounded text-xs transition-colors cursor-pointer",
              compact ? "px-1.5 py-0.5" : "px-2 py-1",
              period === p.value
                ? "bg-[var(--primary)] text-white"
                : "text-[var(--text-muted)] hover:bg-[var(--bg-tertiary)]",
            )}
          >
            {p.label}
          </button>
        ))}
        <div className="ml-auto flex items-center gap-1">
          <DrawingToolbar symbol={activeContract} period={period} />
          <NextBarCountdown symbol={activeContract} period={period} />
          <button
            onClick={() => setSettingsOpen(true)}
            className={cn(
              "px-2 py-1 rounded text-xs transition-colors cursor-pointer",
              indicatorHint
                ? "text-[var(--primary)] bg-[var(--primary)]/10"
                : "text-[var(--text-muted)] hover:bg-[var(--bg-tertiary)]",
            )}
          >
            指标{indicatorHint ? ` ${indicatorHint}` : ""}
          </button>
        </div>
      </div>

      <div className="flex-1 min-h-0 relative">
        {intradayStatus && <div role="status" className="absolute top-1 left-2 z-10 text-xs text-[var(--text-muted)]">{intradayStatus}</div>}
        {isLoading && (
          <div className="absolute inset-0 z-20 flex items-center justify-center bg-[#1a1a1e]/80">
            <span className="text-[var(--text-muted)] text-sm">加载中...</span>
          </div>
        )}
        {maLabels.length > 0 && period !== "tick" && (
          <div className="absolute top-1 left-2 z-10 flex gap-3 text-xs pointer-events-none">
            {maLabels.map((label, i) => (
              <span key={label} style={{ color: config.maLines[i]?.color ?? "#9ca3af" }}>
                {label}
              </span>
            ))}
          </div>
        )}
        <div
          ref={mainRef}
          className="w-full h-full"
          onMouseLeave={() => setHoverPanel(null)}
        />
        {hoverPanel && activeOrderbook && (
          <KlineHoverBookPanel
            x={hoverPanel.x}
            y={hoverPanel.y}
            book={activeOrderbook}
            quote={activeQuote}
          />
        )}
      </div>

      <IndicatorSettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        useStore={indicatorStore}
        bars={currentBars}
        period={period}
      />
    </div>
  )
}
