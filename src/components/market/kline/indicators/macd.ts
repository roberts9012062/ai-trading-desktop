/**
 * MACD 副图注册项：DIF / DEA 双线 + MACD 柱
 * 算法与写入行为迁移自 series-data.ts，逐位不变。
 */

import {
  HistogramSeries,
  LineSeries,
  type IChartApi,
  type ISeriesApi,
  type Time,
} from "lightweight-charts"
import { calcMACD } from "@/lib/indicators"
import type { IndicatorConfig } from "@/types/indicator"
import type { KlineBar, KlinePeriod } from "@/types"
import { formatChartTime, prepareBars } from "../utils"
import { subScaleMargins } from "./pane-sizing"
import type { SubIndicatorDef, SubIndicatorHandle } from "./registry"

/** MACD 三条 series 的固定顺序：DIF 线 / DEA 线 / 柱（handle.series 同序） */
type MacdSeriesTuple = [
  ISeriesApi<"Line">,
  ISeriesApi<"Line">,
  ISeriesApi<"Histogram">,
]

/** 从 handle 取回固定顺序的 MACD 三线（创建方保证顺序） */
function macdTuple(h: SubIndicatorHandle): MacdSeriesTuple | null {
  const [dif, dea, hist] = h.series as MacdSeriesTuple
  if (!dif || !dea || !hist) return null
  return [dif, dea, hist]
}

export const MACD_DEF: SubIndicatorDef = {
  id: "macd",
  label: "MACD",
  isEnabled: (cfg: IndicatorConfig): boolean => cfg.macd.enabled,

  createSeries: (
    chart: IChartApi,
    cfg: IndicatorConfig,
    paneIndex: number,
  ): SubIndicatorHandle => {
    const macd = cfg.macd
    const dif = chart.addSeries(
      LineSeries,
      {
        color: macd.difColor,
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
        priceScaleId: "macd",
      },
      paneIndex,
    )
    const dea = chart.addSeries(
      LineSeries,
      {
        color: macd.deaColor,
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
        priceScaleId: "macd",
      },
      paneIndex,
    )
    const hist = chart.addSeries(
      HistogramSeries,
      {
        priceLineVisible: false,
        lastValueVisible: false,
        priceScaleId: "macd",
      },
      paneIndex,
    )
    chart.priceScale("macd", paneIndex).applyOptions({
      scaleMargins: subScaleMargins(),
      visible: false,
    })
    return { series: [dif, dea, hist], markers: null, paneIndex }
  },

  setData: (
    h: SubIndicatorHandle,
    bars: KlineBar[],
    period: KlinePeriod,
    cfg: IndicatorConfig,
  ): void => {
    const tuple = macdTuple(h)
    if (!tuple) return
    const [difSeries, deaSeries, histSeries] = tuple
    const clean = prepareBars(bars, period)
    const macdData = calcMACD(
      clean,
      cfg.macd.fastPeriod,
      cfg.macd.slowPeriod,
      cfg.macd.signalPeriod,
    )
    if (macdData.length === 0) return
    difSeries.setData(
      macdData.map((d) => ({
        time: formatChartTime(period, d.time),
        value: d.dif,
      })),
    )
    deaSeries.setData(
      macdData.map((d) => ({
        time: formatChartTime(period, d.time),
        value: d.dea,
      })),
    )
    histSeries.setData(
      macdData.map((d) => ({
        time: formatChartTime(period, d.time) as Time,
        value: d.macd,
        color: d.macd >= 0 ? cfg.macd.histUpColor : cfg.macd.histDownColor,
      })),
    )
  },

  updateLast: (
    h: SubIndicatorHandle,
    bars: KlineBar[],
    period: KlinePeriod,
    cfg: IndicatorConfig,
  ): void => {
    const tuple = macdTuple(h)
    if (!tuple) return
    const [difSeries, deaSeries, histSeries] = tuple
    // 沿用迁移前口径：末点增量更新直接用原始 bars，不做写入前清洗
    const macdData = calcMACD(
      bars,
      cfg.macd.fastPeriod,
      cfg.macd.slowPeriod,
      cfg.macd.signalPeriod,
    )
    const lastPoint = macdData[macdData.length - 1]
    if (!lastPoint) return
    const t = formatChartTime(period, lastPoint.time)
    difSeries.update({ time: t, value: lastPoint.dif })
    deaSeries.update({ time: t, value: lastPoint.dea })
    histSeries.update({
      time: t,
      value: lastPoint.macd,
      color:
        lastPoint.macd >= 0 ? cfg.macd.histUpColor : cfg.macd.histDownColor,
    })
  },
}
