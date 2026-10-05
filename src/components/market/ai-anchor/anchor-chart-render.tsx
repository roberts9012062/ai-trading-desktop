"use client";

/**
 * 主播K线渲染核心 —— 蜡烛图 + 标注虚线 + 区域色带 + 未来走势投影
 *
 * 从 AnchorChartDialog 抽出的受控组件（无弹窗外壳）：
 * 主播图解弹窗与 AI 对话内嵌图表共用同一渲染链。
 */

import { memo, useEffect, useRef, useState } from "react"
import { CandlestickSeries, createChart, LineStyle } from "lightweight-charts"
import {
  dedupeBarsByChartTime,
  formatChartTime,
  makeChartOpts,
  sanitizeBars,
} from "@/components/market/kline/utils"
import { getKlineApi } from "@/lib/api"
import { useDisplayStore } from "@/stores/display"
import {
  addAnnotationLines,
  addProjectionSeries,
  applyPriceBounds,
  drawZoneOverlay,
  type AnchorAnnotations,
} from "./anchor-chart-annotations"
import type { KlineBar, KlinePeriod } from "@/types"

interface AnchorChartRenderProps {
  symbol: string
  /** K线周期 1m/5m/15m/30m/60m/240m/1d */
  period: string
  /** 拉取根数 */
  limit: number
  /** 画线标注；null 只画蜡烛 */
  annotations?: AnchorAnnotations | null
  /** K线加载后基于真实数据构建标注（如合成示例结论）；annotations 优先 */
  buildAnnotations?: (bars: KlineBar[]) => AnchorAnnotations
  /** 变化时重建图表（如换了一条播报结论） */
  reloadKey?: string | number
}

/**
 * K线渲染核心（memo）：同一 symbol/period/limit/reloadKey 不重渲染——
 * 流式对话中消息对象每次更新都会新建 annotations 引用，
 * 以 reloadKey（chart 指令 JSON / 播报 id）为内容标识防止图表频繁重建。
 */
export const AnchorChartRender = memo(
  function AnchorChartRender({
    symbol,
    period,
    limit,
    annotations,
    buildAnnotations,
    reloadKey,
  }: AnchorChartRenderProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const overlayRef = useRef<HTMLCanvasElement>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // K线涨跌颜色（显示设置自定义）
  const candleUp = useDisplayStore((s) => s.candleUp)
  const candleDown = useDisplayStore((s) => s.candleDown)

  useEffect(() => {
    const container = containerRef.current
    if (!container || !symbol || !period) return
    let disposed = false

    const chart = createChart(container, {
      ...makeChartOpts(),
      width: container.clientWidth,
      height: container.clientHeight,
    })
    const series = chart.addSeries(CandlestickSeries, {
      upColor: candleUp,
      downColor: candleDown,
      borderUpColor: candleUp,
      borderDownColor: candleDown,
      wickUpColor: candleUp,
      wickDownColor: candleDown,
    })
    const ro = new ResizeObserver(([entry]) => {
      chart.applyOptions({
        width: entry.contentRect.width,
        height: entry.contentRect.height,
      })
      redraw()
    })
    ro.observe(container)

    // 区域色带重画退订钩子(异步流程里注册,cleanup 统一退订)
    let unsubscribeRedraw: (() => void) | null = null
    // 最新 zones(数据加载后更新;重绘回调在加载完成前画空即可)
    let currentZones: Parameters<typeof drawZoneOverlay>[2] = []
    function redraw(): void {
      if (overlayRef.current) {
        drawZoneOverlay(overlayRef.current, series, currentZones)
      }
    }
    // 关键:色带画在 overlay canvas 上,首次同步调用时布局可能未完成
    // (canvas clientWidth 还是默认 300×150),必须观察 canvas 自身尺寸变化重画
    const roOverlay = new ResizeObserver(() => redraw())
    if (overlayRef.current) roOverlay.observe(overlayRef.current)

    setLoading(true)
    setError(null)
    void (async () => {
      try {
        const resp = await getKlineApi(symbol, period, { limit })
        if (disposed) return
        const klinePeriod = period as KlinePeriod
        const bars = dedupeBarsByChartTime(
          sanitizeBars(resp.bars as unknown as KlineBar[]),
          klinePeriod,
        )
        const chartData = bars.map((k) => ({
          time: formatChartTime(klinePeriod, k.time),
          open: k.open,
          high: k.high,
          low: k.low,
          close: k.close,
        }))
        series.setData(chartData)
        chart.timeScale().fitContent()

        // 标注来源：外部传入优先；否则用K线数据现场构建（示例结论等）
        const ann = annotations ?? (buildAnnotations ? buildAnnotations(bars) : null)
        if (ann) {
          // 撑开价格范围到 [蜡烛∪标注],否则超出蜡烛区间的线被裁在可视区外
          applyPriceBounds(chart, bars, chartData.map((point) => point.time), ann)
          addAnnotationLines(series, ann)
          // 箱体/区间上下沿虚线:canvas 色带之外的双保险,任何情况下可见
          for (const zone of ann.zones) {
            series.createPriceLine({
              price: zone.upper,
              color: zone.borderColor,
              lineWidth: 1,
              lineStyle: LineStyle.Dashed,
              axisLabelVisible: true,
              title: `${zone.label}上 ${zone.upper}`,
            })
            series.createPriceLine({
              price: zone.lower,
              color: zone.borderColor,
              lineWidth: 1,
              lineStyle: LineStyle.Dashed,
              axisLabelVisible: true,
              title: `${zone.label}下 ${zone.lower}`,
            })
          }
          if (ann.projection && chartData.length > 0) {
            const lastClose = chartData[chartData.length - 1].close
            addProjectionSeries(
              chart,
              chartData.map((point) => point.time),
              ann.projection,
              lastClose,
            )
          }
        }

        // 区域色带:数据就绪后画,布局稳定后再补一帧,视口变化重画
        currentZones = ann?.zones ?? []
        redraw()
        requestAnimationFrame(redraw)
        chart.timeScale().subscribeVisibleTimeRangeChange(redraw)
        chart.timeScale().subscribeVisibleLogicalRangeChange(redraw)
        unsubscribeRedraw = () => {
          chart.timeScale().unsubscribeVisibleTimeRangeChange(redraw)
          chart.timeScale().unsubscribeVisibleLogicalRangeChange(redraw)
        }
      } catch (err) {
        if (!disposed) {
          setError(err instanceof Error ? err.message : "K线数据加载失败")
        }
      } finally {
        if (!disposed) setLoading(false)
      }
    })()

    return () => {
      disposed = true
      if (unsubscribeRedraw) unsubscribeRedraw()
      ro.disconnect()
      roOverlay.disconnect()
      chart.remove()
    }
  }, [symbol, period, limit, reloadKey, annotations, buildAnnotations, candleUp, candleDown])

  return (
    <div className="relative w-full h-full">
      <div ref={containerRef} className="absolute inset-0" />
      <canvas ref={overlayRef} className="absolute inset-0 pointer-events-none" />
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center text-xs text-[var(--text-muted)] bg-[var(--bg-secondary)]/60">
          加载K线…
        </div>
      )}
      {error && (
        <div className="absolute inset-0 flex items-center justify-center text-xs text-red-400">
          {error}
        </div>
      )}
    </div>
  )
  },
  (prev, next) =>
    prev.symbol === next.symbol &&
    prev.period === next.period &&
    prev.limit === next.limit &&
    prev.reloadKey === next.reloadKey,
)

// memo 比较 props 不含 store 订阅：颜色变化时 store selector 触发本组件重渲染
// （candleUp/candleDown 直接来自 useDisplayStore，不走 props），无需改 memo。
