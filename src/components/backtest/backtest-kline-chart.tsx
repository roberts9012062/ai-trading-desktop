"use client"

/**
 * 回测 K 线 + 成交标记 + 技术指标
 * 做多红↑ / 做空绿↓ / 平仓蓝● —— 均在 K 线下方
 * 指标（MA/BOLL/MACD/RSI/KDJ）复用实时行情的指标配置与计算
 */

import { useEffect, useRef, useState } from "react"
import {
  CandlestickSeries,
  ColorType,
  createChart,
  createSeriesMarkers,
  type IChartApi,
  type ISeriesApi,
  type SeriesMarker,
  type Time,
} from "lightweight-charts"
import { Settings2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { IndicatorSettingsDialog } from "@/components/market/indicator-settings-dialog"
import { useBacktestIndicatorStore } from "@/stores/backtest-indicator"
import { useDisplayStore } from "@/stores/display"
import type { BacktestBar, BacktestTrade } from "@/lib/backtest-api"
import { formatChartTime, chineseTickMarkFormatter } from "@/components/market/kline/utils"
import type { KlinePeriod } from "@/types"
import {
  bindAllIndicatorData,
  useIndicatorSeries,
} from "@/components/backtest/use-indicator-series"

interface BacktestKlineChartProps {
  bars: BacktestBar[]
  trades: BacktestTrade[]
  timeframe: string
}

function asPeriod(timeframe: string): KlinePeriod {
  const t = timeframe as KlinePeriod
  if (
    t === "1m" ||
    t === "5m" ||
    t === "15m" ||
    t === "30m" ||
    t === "60m" || t === "240m" ||
    t === "1d"
  ) {
    return t
  }
  return "1d"
}

function tradeMarkers(
  trades: BacktestTrade[],
  period: KlinePeriod,
  validTimes: Set<string>,
): SeriesMarker<Time>[] {
  const markers: SeriesMarker<Time>[] = []
  for (const t of trades) {
    const time = formatChartTime(period, String(t.time || ""))
    const key = String(time)
    if (!key || key === "0" || key === "NaN" || !validTimes.has(key)) continue
    const action = String(t.action || "").toLowerCase()
    if (action === "open_long") {
      markers.push({
        time, position: "belowBar", shape: "arrowUp",
        color: "#ef4444", text: "多", size: 1.5,
      })
    } else if (action === "open_short") {
      markers.push({
        time, position: "belowBar", shape: "arrowDown",
        color: "#22c55e", text: "空", size: 1.5,
      })
    } else if (action === "close") {
      markers.push({
        time, position: "belowBar", shape: "circle",
        color: "#3b82f6", text: "平", size: 1.5,
      })
    }
  }
  markers.sort((a, b) => {
    const ta = typeof a.time === "number" ? a.time : String(a.time)
    const tb = typeof b.time === "number" ? b.time : String(b.time)
    if (ta < tb) return -1
    if (ta > tb) return 1
    return 0
  })
  return markers
}

/** 回测 K 线主图 */
export function BacktestKlineChart({
  bars,
  trades,
  timeframe,
}: BacktestKlineChartProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const [chart, setChart] = useState<IChartApi | null>(null)
  const [candleSeries, setCandleSeries] = useState<ISeriesApi<"Candlestick"> | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)

  const period = asPeriod(timeframe)
  const indicatorRefs = useIndicatorSeries({ chart, candleSeries, period })
  const config = useBacktestIndicatorStore((s) => s.config)

  // 创建 chart + 蜡烛 series + 标记
  // K线涨跌颜色（显示设置自定义）
  const candleUp = useDisplayStore((s) => s.candleUp)
  const candleDown = useDisplayStore((s) => s.candleDown)

  useEffect(() => {
    if (!containerRef.current || bars.length === 0) return

    const ch = createChart(containerRef.current, {
      height: 380,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: "#9ca3af",
      },
      grid: {
        vertLines: { color: "#2e2e33" },
        horzLines: { color: "#2e2e33" },
      },
      rightPriceScale: { borderColor: "#3a3a40" },
      timeScale: {
        borderColor: "#3a3a40",
        timeVisible: period !== "1d",
        barSpacing: 14,
        minBarSpacing: 4,
        tickMarkFormatter: chineseTickMarkFormatter,
      },
      crosshair: {
        vertLine: { color: "#6b7280", labelBackgroundColor: "#3b82f6" },
        horzLine: { color: "#6b7280", labelBackgroundColor: "#3b82f6" },
      },
    })

    const candle = ch.addSeries(CandlestickSeries, {
      upColor: candleUp, downColor: candleDown,
      borderUpColor: "#ef4444",
      borderDownColor: "#22c55e",
      wickUpColor: "#ef4444",
      wickDownColor: "#22c55e",
    })

    const byTime = new Map<string, { time: Time; open: number; high: number; low: number; close: number }>()
    for (const b of bars) {
      if (b.open <= 0 || b.high <= 0 || b.low <= 0 || b.close <= 0) continue
      const time = formatChartTime(period, b.time)
      const key = String(time)
      if (!key || key === "0" || key === "NaN") continue
      byTime.set(key, { time, open: b.open, high: b.high, low: b.low, close: b.close })
    }
    const deduped = Array.from(byTime.values()).sort((a, b) => {
      const ta = a.time as string | number
      const tb = b.time as string | number
      return ta < tb ? -1 : ta > tb ? 1 : 0
    })
    candle.setData(deduped)

    try {
      const validTimes = new Set(deduped.map((d) => String(d.time)))
      const markers = tradeMarkers(trades, period, validTimes)
      createSeriesMarkers(candle, markers)
    } catch {
      // markers 插件失败时仍显示 K 线
    }

    ch.timeScale().fitContent()
    setChart(ch)
    setCandleSeries(candle)

    const ro = new ResizeObserver(() => {
      if (containerRef.current) ch.applyOptions({ width: containerRef.current.clientWidth })
    })
    ro.observe(containerRef.current)

    return () => {
      ro.disconnect()
      ch.remove()
      setChart(null)
      setCandleSeries(null)
    }
    // 故意不把 period 放依赖——timeframe 变化由父组件控制 bars 重新触发
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bars, trades, timeframe, candleUp, candleDown])

  // 指标 series 就绪后全量绑定数据（含成交量）
  useEffect(() => {
    if (!chart || !candleSeries || bars.length === 0) return
    bindAllIndicatorData(indicatorRefs, bars, period)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chart, candleSeries, config, bars])

  // 活跃指标徽章
  const activeIndicators: string[] = []
  for (const ma of config.maLines) activeIndicators.push(`MA${ma.period}`)
  if (config.boll.enabled) activeIndicators.push("BOLL")
  if (config.macd.enabled) activeIndicators.push("MACD")
  if (config.rsi.enabled) activeIndicators.push("RSI")
  if (config.jdk.enabled) activeIndicators.push("KDJ")

  if (bars.length === 0) {
    return (
      <div className="h-[380px] flex items-center justify-center text-sm text-[var(--text-muted)]">
        无 K 线数据
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {/* 指标徽章 + 设置入口 */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex flex-wrap gap-1.5 text-[11px]">
          {activeIndicators.map((tag) => (
            <span key={tag} className="px-1.5 py-0.5 rounded bg-[var(--bg-tertiary)] text-[var(--text-muted)]">
              {tag}
            </span>
          ))}
        </div>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 px-2 text-xs"
          onClick={() => setSettingsOpen(true)}
        >
          <Settings2 className="w-3.5 h-3.5 mr-1" />
          指标设置
        </Button>
      </div>

      <div ref={containerRef} className="w-full" />
      <div className="flex flex-wrap gap-3 text-[11px] text-[var(--text-muted)] px-1">
        <span className="inline-flex items-center gap-1">
          <span className="w-2 h-2 rounded-full bg-[#ef4444]" />
          做多（红↑）
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="w-2 h-2 rounded-full bg-[#22c55e]" />
          做空（绿↓）
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="w-2 h-2 rounded-full bg-[#3b82f6]" />
          平仓（蓝●）
        </span>
      </div>

      <IndicatorSettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        useStore={useBacktestIndicatorStore}
        bars={bars}
        period={period}
      />
    </div>
  )
}
