/**
 * 回测图表共享指标 hook
 *
 * 把实时行情图表的指标管道（MA/BOLL/MACD/RSI/KDJ + 成交量）复用到回测图表。
 * 副图指标直接复用行情页注册表（kline/indicators/registry.ts），
 * 主图叠加复用 kline/indicators/main.ts；v5 原生 panes 布局与行情页一致，
 * 开关/参数/颜色复用 stores/backtest-indicator.ts（回测页隔离配置）。
 *
 * 两种用法：
 * - 全量模式（报告图）：bars 变化时整体 setData
 * - 增量模式（回放图）：每推一根后调 updateIndicatorLastPoints 增量更新末点
 */

"use client"

import { useEffect, useRef } from "react"
import type { IChartApi, ISeriesApi, Time } from "lightweight-charts"
import { useBacktestIndicatorStore } from "@/stores/backtest-indicator"
import type { BacktestBar } from "@/lib/backtest-api"
import type { KlineBar, KlinePeriod } from "@/types"
import {
  createBollSeries,
  createMaSeriesList,
  createVolumeSeries,
  setBollSeriesData,
  setMaSeriesData,
  updateBollLastPoints,
  updateMaLastPoints,
  type BollSeriesRefs,
} from "@/components/market/kline/indicators/main"
import { applyMainScaleMargins } from "@/components/market/kline/indicators/pane-sizing"
import {
  createSubIndicatorPanes,
  removeSubIndicatorSeries,
  updateSubIndicatorsLast,
  writeSubIndicatorsData,
  type SubIndicatorHandle,
  type SubIndicatorId,
} from "@/components/market/kline/indicators/registry"
import { formatChartTime } from "@/components/market/kline/utils"

/** 指标 series 引用集合（卸载时用于清理） */
interface IndicatorSeriesRefs {
  volume: ISeriesApi<"Histogram"> | null
  ma: ISeriesApi<"Line">[]
  boll: BollSeriesRefs
  /** 副图指标图元（注册表 id → handle） */
  subs: Map<SubIndicatorId, SubIndicatorHandle>
}

function emptyRefs(): IndicatorSeriesRefs {
  return {
    volume: null,
    ma: [],
    boll: [null, null, null],
    subs: new Map(),
  }
}

interface UseIndicatorSeriesOptions {
  /** 已创建的 chart 实例（必须已含 candlestick series） */
  chart: IChartApi | null
  /** 蜡烛 series（指标叠加在它所在的主图上） */
  candleSeries: ISeriesApi<"Candlestick"> | null
  /** K 线周期 */
  period: KlinePeriod
}

/**
 * 在回测 chart 上挂载指标 series，并在 indicator store 配置变化时重建。
 * 返回一个 ref，持有所有指标 series 引用，供全量/增量数据绑定使用。
 */
export function useIndicatorSeries({
  chart,
  candleSeries,
  period,
}: UseIndicatorSeriesOptions): React.MutableRefObject<IndicatorSeriesRefs> {
  const refs = useRef<IndicatorSeriesRefs>(emptyRefs())

  const config = useBacktestIndicatorStore((s) => s.config)

  useEffect(() => {
    if (!chart || !candleSeries) return

    // 清理上一轮 series
    const cleanupSeries = (
      s: ISeriesApi<"Line" | "Histogram"> | null,
    ): void => {
      if (s) {
        try {
          chart.removeSeries(s)
        } catch {
          /* 已被移除 */
        }
      }
    }
    const prev = refs.current
    cleanupSeries(prev.volume)
    prev.ma.forEach(cleanupSeries)
    prev.boll.forEach(cleanupSeries)
    removeSubIndicatorSeries(chart, prev.subs)

    const next = emptyRefs()

    // 主图边距（回测无波段标记，恒用默认顶部留白）；
    // 每个启用的副图指标开独立 pane（顺序 = 注册表顺序）
    applyMainScaleMargins(chart, false)
    next.volume = createVolumeSeries(chart)
    next.ma = createMaSeriesList(chart, config.maLines)
    if (config.boll.enabled) {
      next.boll = createBollSeries(chart, config.boll)
    }
    createSubIndicatorPanes(chart, config, next.subs)

    refs.current = next

    return () => {
      cleanupSeries(next.volume)
      next.ma.forEach(cleanupSeries)
      next.boll.forEach(cleanupSeries)
      removeSubIndicatorSeries(chart, next.subs)
      refs.current = emptyRefs()
    }
  }, [chart, candleSeries, config, period])

  return refs
}

/** BacktestBar[] → KlineBar[]（结构兼容，补齐可选字段） */
function toKlineBars(bars: BacktestBar[]): KlineBar[] {
  return bars.map((b) => ({
    time: b.time,
    open: b.open,
    high: b.high,
    low: b.low,
    close: b.close,
    volume: b.volume,
  }))
}

/** 全量绑定所有指标数据（报告图用：一次性画完） */
export function bindAllIndicatorData(
  refs: React.MutableRefObject<IndicatorSeriesRefs>,
  bars: BacktestBar[],
  period: KlinePeriod,
): void {
  const config = useBacktestIndicatorStore.getState().config
  const klines = toKlineBars(bars)
  const { volume, ma, boll, subs } = refs.current

  // 成交量
  if (volume) {
    volume.setData(
      klines.map((k) => ({
        time: formatChartTime(period, k.time) as Time,
        value: k.volume,
        color: k.close >= k.open ? "rgba(239,68,68,0.3)" : "rgba(34,197,94,0.3)",
      })),
    )
  }
  if (klines.length === 0) return

  setMaSeriesData(ma, klines, period, config.maLines)
  if (config.boll.enabled) {
    setBollSeriesData(boll, klines, period, config.boll)
  }
  writeSubIndicatorsData(subs, klines, period, config)
}

/** 增量更新所有指标末点（回放图用：每推一根后调用） */
export function updateIndicatorLastPoints(
  refs: React.MutableRefObject<IndicatorSeriesRefs>,
  bars: BacktestBar[],
  period: KlinePeriod,
): void {
  const config = useBacktestIndicatorStore.getState().config
  if (bars.length === 0) return
  const klines = toKlineBars(bars)
  const { ma, boll, subs } = refs.current

  updateMaLastPoints(ma, klines, period, config.maLines)
  if (config.boll.enabled) {
    updateBollLastPoints(boll, klines, period, config.boll)
  }
  updateSubIndicatorsLast(subs, klines, period, config)
}

/** 单根 bar 推入成交量 series（回放图增量用） */
export function pushVolumeBar(
  refs: React.MutableRefObject<IndicatorSeriesRefs>,
  bar: BacktestBar,
  period: KlinePeriod,
): void {
  const vol = refs.current.volume
  if (!vol) return
  vol.update({
    time: formatChartTime(period, bar.time) as Time,
    value: bar.volume,
    color: bar.close >= bar.open ? "rgba(239,68,68,0.3)" : "rgba(34,197,94,0.3)",
  })
}
