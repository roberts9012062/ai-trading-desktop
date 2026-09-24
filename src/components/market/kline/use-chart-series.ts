"use client"

/**
 * K 线 series 结构创建 + 数据写入（不含实时增量 update）
 * 主图（蜡烛/量/MA/BOLL）走 indicators/main.ts，
 * 副图指标遍历 indicators/registry.ts 注册表，不再逐指标写分支。
 */

import {
  useEffect,
  useRef,
  type Dispatch,
  type MutableRefObject,
  type RefObject,
  type SetStateAction,
} from "react"
import {
  LineSeries,
  type IChartApi,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type Time,
} from "lightweight-charts"
import { useMarketStore } from "@/stores/market"
import { useContractSpecStore } from "@/stores/contract-spec"
import { useDisplayStore } from "@/stores/display"
import type { IndicatorConfig } from "@/types/indicator"
import type { KlineBar, KlinePeriod } from "@/types"
import {
  clearMainAndSubData,
  createBollSeries,
  createCandleSeries,
  createMaSeriesList,
  createVolumeSeries,
  writeMainAndSubData,
  type BollSeriesRefs,
} from "./indicators/main"
import { applyMainScaleMargins } from "./indicators/pane-sizing"
import {
  createSubIndicatorPanes,
  removeSubIndicatorSeries,
  type SubIndicatorHandle,
  type SubIndicatorId,
} from "./indicators/registry"
import {
  applyPivotMarkersByVersion,
  clearPivotMarkers,
} from "./pivot-dispatch"
import { mergeBarsWithRealtime, scheduleHalfEmptyScroll } from "./utils"
import { maintainViewportAfterData } from "./realtime/scroll"

export function useChartSeries(props: {
  mainApiRef: RefObject<IChartApi | null>
  seriesRef: MutableRefObject<ISeriesApi<"Candlestick"> | null>
  tickSeriesRef: MutableRefObject<ISeriesApi<"Line"> | null>
  volumeRef: MutableRefObject<ISeriesApi<"Histogram"> | null>
  maSeriesRef: MutableRefObject<ISeriesApi<"Line">[]>
  bollSeriesRef: MutableRefObject<BollSeriesRefs>
  subHandlesRef: MutableRefObject<Map<SubIndicatorId, SubIndicatorHandle>>
  pivotMarkersRef: MutableRefObject<ISeriesMarkersPluginApi<Time> | null>
  currentBarsRef: MutableRefObject<KlineBar[]>
  currentBars: KlineBar[]
  period: KlinePeriod
  activeContract: string
  config: IndicatorConfig
  isNearLatest: MutableRefObject<boolean>
  lastRealtimeTime: MutableRefObject<string | null>
  scrollTimerRef: MutableRefObject<ReturnType<typeof setTimeout> | null>
  skipScrollRef: MutableRefObject<boolean>
  prevBarsCountRef: MutableRefObject<number>
  savedRangeRef: MutableRefObject<{ from: number; to: number } | null>
  setMaLabels: Dispatch<SetStateAction<string[]>>
  chartReady: number
  /** 蜡烛 series 创建/重建完成后回调，供挂单线重绘 */
  onSeriesReady: (() => void) | null
}): void {
  const {
    mainApiRef, seriesRef, tickSeriesRef, volumeRef, maSeriesRef, bollSeriesRef,
    subHandlesRef, pivotMarkersRef, currentBarsRef, currentBars, period,
    activeContract, config, isNearLatest, lastRealtimeTime, scrollTimerRef,
    skipScrollRef, prevBarsCountRef, savedRangeRef, setMaLabels, chartReady,
    onSeriesReady,
  } = props

  // 用 ref 持有回调，避免放入 effect 依赖导致重建死循环
  const onSeriesReadyRef = useRef(onSeriesReady)
  onSeriesReadyRef.current = onSeriesReady

  // K线涨跌颜色（显示设置自定义，localStorage 持久化）；变化时重建 series
  const candleUp = useDisplayStore((s) => s.candleUp)
  const candleDown = useDisplayStore((s) => s.candleDown)

  /** 主图 + 副图一次写入（波段 markers 由调用方另行挂载） */
  const writeAll = (barsToRender: KlineBar[]): void => {
    const series = seriesRef.current
    const vol = volumeRef.current
    if (!series || !vol) return
    writeMainAndSubData({
      series,
      volume: vol,
      maSeriesList: maSeriesRef.current,
      bollSeries: bollSeriesRef.current,
      subHandles: subHandlesRef.current,
      bars: barsToRender,
      period,
      config,
      setMaLabels,
    })
  }

  /** setData 失败回退：清空均线与波段标记，避免残留上一品种残影 */
  const clearOnFailure = (): void => {
    for (const s of maSeriesRef.current) {
      try { s.setData([]) } catch { /* 已销毁 */ }
    }
    setMaLabels([])
    clearPivotMarkers(pivotMarkersRef)
  }

  useEffect(() => {
    if (chartReady === 0) return
    const chart = mainApiRef.current
    if (!chart) return

    lastRealtimeTime.current = null
    isNearLatest.current = true
    // 切品种/周期后强制半空，不沿用上一份 bar 计数
    prevBarsCountRef.current = 0

    // 清理旧 series
    const remove = (s: ISeriesApi<"Line" | "Candlestick" | "Histogram"> | null) => {
      if (!s) return
      try { chart.removeSeries(s) } catch { /* 已销毁 */ }
    }
    // markers 挂在 candle series 上，重建 series 前先卸掉
    clearPivotMarkers(pivotMarkersRef)
    remove(seriesRef.current); seriesRef.current = null
    remove(tickSeriesRef.current); tickSeriesRef.current = null
    remove(volumeRef.current); volumeRef.current = null
    for (const s of maSeriesRef.current) remove(s)
    maSeriesRef.current = []
    bollSeriesRef.current.forEach(remove)
    bollSeriesRef.current = [null, null, null]
    removeSubIndicatorSeries(chart, subHandlesRef.current)
    subHandlesRef.current = new Map()

    if (period === "tick") {
      tickSeriesRef.current = chart.addSeries(LineSeries, {
        color: "#3b82f6", lineWidth: 1, priceLineVisible: false, lastValueVisible: true,
      })
      return
    }

    // 波段「空/多」标记需要顶部留白，否则 aboveBar 贴顶被裁
    const pivotEnabled = config.pivot?.enabled ?? false
    const series = createCandleSeries(chart, candleUp, candleDown)
    seriesRef.current = series
    applyMainScaleMargins(chart, pivotEnabled)
    volumeRef.current = createVolumeSeries(chart)
    maSeriesRef.current = createMaSeriesList(chart, config.maLines)
    if (config.boll.enabled) {
      bollSeriesRef.current = createBollSeries(chart, config.boll)
    }
    // 每个启用的副图指标开独立 pane（顺序 = 注册表顺序）
    createSubIndicatorPanes(chart, config, subHandlesRef.current)

    const bars = currentBarsRef.current
    if (bars.length > 0) {
      const rtBar = useMarketStore.getState().klineRealtime[activeContract]?.[period as KlinePeriod]
      const barsToRender = mergeBarsWithRealtime(bars, rtBar, period)
      try {
        writeAll(barsToRender)
        applyPivotMarkersByVersion(series, pivotMarkersRef, barsToRender, period, config)
      } catch (err) {
        console.warn("[K线 setData 失败]", period, activeContract, err)
        // 蜡烛失败时清空均线，避免残留上一品种曲线（竖线掉到 0）
        clearOnFailure()
      }
    } else {
      setMaLabels([])
      clearPivotMarkers(pivotMarkersRef)
    }

    if (scrollTimerRef.current) clearTimeout(scrollTimerRef.current)
    isNearLatest.current = true
    // 切品种/周期：最新 K 居中，右侧留约一半空白（多次重试，等布局/setData）
    const nBars = bars.length
    // 半空布局：少次重试即可，避免长时间占用
    const cancelHalf = scheduleHalfEmptyScroll(
      () => mainApiRef.current,
      nBars,
      [0, 80, 250],
    )
    scrollTimerRef.current = setTimeout(() => {
      cancelHalf()
      scrollTimerRef.current = null
    }, 400)
    prevBarsCountRef.current = bars.length
    // series 重建后通知挂单线重绘（不把回调放进 deps，防死循环）
    const notify = onSeriesReadyRef.current
    if (notify) {
      queueMicrotask(() => notify())
    }
    return () => {
      cancelHalf()
    }
    // 注意：不依赖 activeContract —— 切品种只走下方 setData 路径，避免整表销毁重建闪黑
  }, [
    period, config, chartReady, mainApiRef, seriesRef, tickSeriesRef, volumeRef,
    maSeriesRef, bollSeriesRef, subHandlesRef, pivotMarkersRef, currentBarsRef,
    lastRealtimeTime, isNearLatest, scrollTimerRef, prevBarsCountRef,
    setMaLabels, candleUp, candleDown,
  ])

  // 按品种 tick 设置蜡烛 series 的价格精度（影响十字线价格轴标签）
  const specsLoaded = useContractSpecStore((s) => s.loaded)
  useEffect(() => {
    let raf = 0
    const apply = () => {
      const series = seriesRef.current
      if (!series) {
        // series 可能尚未创建（chartReady 先于 series 赋值），下一帧重试
        raf = requestAnimationFrame(apply)
        return
      }
      const specStore = useContractSpecStore.getState()
      const spec = specStore.getSpec(activeContract)
      let precision: number
      let minMove: number
      if (spec) {
        precision = spec.decimal_places
        minMove = spec.tick_size
      } else {
        // 规格未加载/未命中：回退行情小数位或最新价量级；
        // 二者皆缺时跳过 —— 绝不能落 spec 默认 0/1（rAF 晚于数据写入路径执行，
        // 会把已设好的微价格精度覆盖成 precision=0/minMove=1，日线轴全变 0）
        const q = useMarketStore.getState().quotes[activeContract]
        const dec = q?.decimal_places
        if (typeof dec === "number" && dec >= 0 && dec <= 10) {
          precision = dec
        } else {
          const p = Number(q?.last_price) || 0
          if (p <= 0) return
          precision =
            p >= 10000 ? 1 : p >= 100 ? 2 : p >= 1 ? 3 : p >= 0.1 ? 4
            : p >= 0.01 ? 5 : p >= 0.001 ? 6 : p >= 0.0001 ? 7
            : p >= 0.00001 ? 8 : 9
        }
        minMove = Number((10 ** -precision).toFixed(precision))
      }
      try {
        series.applyOptions({
          priceFormat: { type: "price", precision, minMove },
        })
      } catch {
        /* ignore */
      }
    }
    raf = requestAnimationFrame(apply)
    return () => cancelAnimationFrame(raf)
  }, [activeContract, chartReady, specsLoaded])

  useEffect(() => {
    const series = seriesRef.current
    const vol = volumeRef.current
    if (!series || !vol || period === "tick") return

    // 切到「无缓存/拉取中/拉取失败」的合约：必须清空旧合约残影。
    // 否则图表继续显示上一品种的 K 线，而标题/价格轴已是新合约
    // （切回合约偶发错图的根因：后端源限流时返回慢/空，窗口期旧图滞留）。
    if (currentBars.length === 0) {
      clearMainAndSubData({
        series,
        volume: vol,
        maSeriesList: maSeriesRef.current,
        bollSeries: bollSeriesRef.current,
        subHandles: subHandlesRef.current,
      })
      setMaLabels([])
      clearPivotMarkers(pivotMarkersRef)
      prevBarsCountRef.current = 0
      return
    }

    const rtBar = useMarketStore.getState().klineRealtime[activeContract]?.[period as KlinePeriod]
    // 实时 bar 落后历史时 merge 会返回 null —— 必须回退历史，否则分钟线永远 setData 不上
    const barsToRender =
      mergeBarsWithRealtime(currentBars, rtBar, period) ?? currentBars
    if (barsToRender.length === 0) return

    // 价格精度自适应（写入路径同步应用，杜绝首载 ref 时机漏洞）：
    // 规格小数位（行情 quote）优先，量级阶梯兜底（微价格币 9 位）
    try {
      const q = useMarketStore.getState().quotes[activeContract]
      const dec = q?.decimal_places
      const lastClose = barsToRender[barsToRender.length - 1]?.close
      let prec: number
      if (typeof dec === "number" && dec >= 0 && dec <= 10) {
        prec = dec
      } else {
        const p = Number(lastClose) || 0
        prec =
          p >= 10000 ? 1 : p >= 100 ? 2 : p >= 1 ? 3 : p >= 0.1 ? 4
          : p >= 0.01 ? 5 : p >= 0.001 ? 6 : p >= 0.0001 ? 7
          : p >= 0.00001 ? 8 : p > 0 ? 9 : 2
      }
      const minMove = Number((10 ** -prec).toFixed(prec))
      series.applyOptions({ priceFormat: { type: "price", precision: prec, minMove } })
      for (const s of maSeriesRef.current) {
        s?.applyOptions({ priceFormat: { type: "price", precision: prec, minMove } })
      }
      for (const s of bollSeriesRef.current) {
        s?.applyOptions({ priceFormat: { type: "price", precision: prec, minMove } })
      }
      writeAll(barsToRender)
      applyPivotMarkersByVersion(series, pivotMarkersRef, barsToRender, period, config)
    } catch (err) {
      console.warn("[K线 setData 失败]", period, activeContract, err)
      clearOnFailure()
      return
    }

    // 视口维持：懒加载 prepend 锚点 / 数据到达贴最新半空
    maintainViewportAfterData(
      {
        mainApiRef,
        isNearLatest,
        scrollTimerRef,
        skipScrollRef,
        savedRangeRef,
        prevBarsCountRef,
      },
      currentBars.length,
      prevBarsCountRef.current,
    )
    prevBarsCountRef.current = currentBars.length
  }, [
    currentBars, period, config, activeContract, seriesRef, volumeRef,
    maSeriesRef, bollSeriesRef, subHandlesRef, pivotMarkersRef, mainApiRef,
    scrollTimerRef, skipScrollRef, savedRangeRef, prevBarsCountRef,
    setMaLabels, isNearLatest,
  ])
}
