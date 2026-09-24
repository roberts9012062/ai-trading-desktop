/**
 * RSI 副图注册项：主线 + 超买/超卖参考线
 * 算法与写入行为迁移自 series-data.ts，逐位不变。
 */

import {
  LineSeries,
  type IChartApi,
  type ISeriesApi,
} from "lightweight-charts"
import { calcRSI } from "@/lib/indicators"
import type { IndicatorConfig } from "@/types/indicator"
import type { KlineBar, KlinePeriod } from "@/types"
import { formatChartTime, prepareBars } from "../utils"
import { subScaleMargins } from "./pane-sizing"
import type { SubIndicatorDef, SubIndicatorHandle } from "./registry"

/** RSI 三条 series 的固定顺序：主线 / 超买线 / 超卖线（handle.series 同序） */
type RsiSeriesTuple = [
  ISeriesApi<"Line">,
  ISeriesApi<"Line">,
  ISeriesApi<"Line">,
]

/** 从 handle 取回固定顺序的 RSI 三线（创建方保证顺序） */
function rsiTuple(h: SubIndicatorHandle): RsiSeriesTuple | null {
  const [rsiLine, obLine, osLine] = h.series as RsiSeriesTuple
  if (!rsiLine || !obLine || !osLine) return null
  return [rsiLine, obLine, osLine]
}

export const RSI_DEF: SubIndicatorDef = {
  id: "rsi",
  label: "RSI",
  isEnabled: (cfg: IndicatorConfig): boolean => cfg.rsi.enabled,

  createSeries: (
    chart: IChartApi,
    cfg: IndicatorConfig,
    paneIndex: number,
  ): SubIndicatorHandle => {
    const rsi = cfg.rsi
    const rsiLine = chart.addSeries(
      LineSeries,
      {
        color: rsi.lineColor,
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
        priceScaleId: "rsi",
      },
      paneIndex,
    )
    const obLine = chart.addSeries(
      LineSeries,
      {
        color: rsi.overboughtColor,
        lineWidth: 1,
        lineStyle: 2,
        priceLineVisible: false,
        lastValueVisible: false,
        priceScaleId: "rsi",
      },
      paneIndex,
    )
    const osLine = chart.addSeries(
      LineSeries,
      {
        color: rsi.oversoldColor,
        lineWidth: 1,
        lineStyle: 2,
        priceLineVisible: false,
        lastValueVisible: false,
        priceScaleId: "rsi",
      },
      paneIndex,
    )
    chart.priceScale("rsi", paneIndex).applyOptions({
      scaleMargins: subScaleMargins(),
      visible: false,
    })
    return { series: [rsiLine, obLine, osLine], markers: null, paneIndex }
  },

  setData: (
    h: SubIndicatorHandle,
    bars: KlineBar[],
    period: KlinePeriod,
    cfg: IndicatorConfig,
  ): void => {
    const tuple = rsiTuple(h)
    if (!tuple) return
    const [rsiLine, obLine, osLine] = tuple
    const clean = prepareBars(bars, period)
    const data = calcRSI(clean, cfg.rsi.period)
    if (data.length === 0) return
    rsiLine.setData(
      data.map((d) => ({
        time: formatChartTime(period, d.time),
        value: d.value,
      })),
    )
    obLine.setData(
      data.map((d) => ({
        time: formatChartTime(period, d.time),
        value: cfg.rsi.overbought,
      })),
    )
    osLine.setData(
      data.map((d) => ({
        time: formatChartTime(period, d.time),
        value: cfg.rsi.oversold,
      })),
    )
  },

  updateLast: (
    h: SubIndicatorHandle,
    bars: KlineBar[],
    period: KlinePeriod,
    cfg: IndicatorConfig,
  ): void => {
    const tuple = rsiTuple(h)
    if (!tuple) return
    const [rsiLine, obLine, osLine] = tuple
    // 沿用迁移前口径：末点增量更新直接用原始 bars，不做写入前清洗
    const data = calcRSI(bars, cfg.rsi.period)
    const last = data[data.length - 1]
    if (!last) return
    const t = formatChartTime(period, last.time)
    rsiLine.update({ time: t, value: last.value })
    obLine.update({ time: t, value: cfg.rsi.overbought })
    osLine.update({ time: t, value: cfg.rsi.oversold })
  },
}
