/**
 * JDK（KDJ）副图注册项：K / D / J 三线
 * 算法与写入行为迁移自 series-data.ts，逐位不变。
 */

import {
  LineSeries,
  type IChartApi,
  type ISeriesApi,
} from "lightweight-charts"
import { calcKDJ } from "@/lib/indicators"
import type { IndicatorConfig } from "@/types/indicator"
import type { KlineBar, KlinePeriod } from "@/types"
import { formatChartTime, prepareBars } from "../utils"
import { subScaleMargins } from "./pane-sizing"
import type { SubIndicatorDef, SubIndicatorHandle } from "./registry"

/** JDK 三条 series 的固定顺序：K 线 / D 线 / J 线（handle.series 同序） */
type JdkSeriesTuple = [
  ISeriesApi<"Line">,
  ISeriesApi<"Line">,
  ISeriesApi<"Line">,
]

/** 从 handle 取回固定顺序的 JDK 三线（创建方保证顺序） */
function jdkTuple(h: SubIndicatorHandle): JdkSeriesTuple | null {
  const [kLine, dLine, jLine] = h.series as JdkSeriesTuple
  if (!kLine || !dLine || !jLine) return null
  return [kLine, dLine, jLine]
}

export const JDK_DEF: SubIndicatorDef = {
  id: "jdk",
  label: "JDK",
  isEnabled: (cfg: IndicatorConfig): boolean => cfg.jdk.enabled,

  createSeries: (
    chart: IChartApi,
    cfg: IndicatorConfig,
    paneIndex: number,
  ): SubIndicatorHandle => {
    const jdk = cfg.jdk
    const kLine = chart.addSeries(
      LineSeries,
      {
        color: jdk.kColor,
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
        priceScaleId: "jdk",
      },
      paneIndex,
    )
    const dLine = chart.addSeries(
      LineSeries,
      {
        color: jdk.dColor,
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
        priceScaleId: "jdk",
      },
      paneIndex,
    )
    const jLine = chart.addSeries(
      LineSeries,
      {
        color: jdk.jColor,
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
        priceScaleId: "jdk",
      },
      paneIndex,
    )
    chart.priceScale("jdk", paneIndex).applyOptions({
      scaleMargins: subScaleMargins(),
      visible: false,
    })
    return { series: [kLine, dLine, jLine], markers: null, paneIndex }
  },

  setData: (
    h: SubIndicatorHandle,
    bars: KlineBar[],
    period: KlinePeriod,
    cfg: IndicatorConfig,
  ): void => {
    const tuple = jdkTuple(h)
    if (!tuple) return
    const [kSeries, dSeries, jSeries] = tuple
    const clean = prepareBars(bars, period)
    const data = calcKDJ(clean, cfg.jdk.rsvPeriod, cfg.jdk.kPeriod, cfg.jdk.dPeriod)
    if (data.length === 0) return
    kSeries.setData(
      data.map((d) => ({
        time: formatChartTime(period, d.time),
        value: d.k,
      })),
    )
    dSeries.setData(
      data.map((d) => ({
        time: formatChartTime(period, d.time),
        value: d.d,
      })),
    )
    jSeries.setData(
      data.map((d) => ({
        time: formatChartTime(period, d.time),
        value: d.j,
      })),
    )
  },

  updateLast: (
    h: SubIndicatorHandle,
    bars: KlineBar[],
    period: KlinePeriod,
    cfg: IndicatorConfig,
  ): void => {
    const tuple = jdkTuple(h)
    if (!tuple) return
    const [kSeries, dSeries, jSeries] = tuple
    // 沿用迁移前口径：末点增量更新直接用原始 bars，不做写入前清洗
    const data = calcKDJ(bars, cfg.jdk.rsvPeriod, cfg.jdk.kPeriod, cfg.jdk.dPeriod)
    const last = data[data.length - 1]
    if (!last) return
    const t = formatChartTime(period, last.time)
    kSeries.update({ time: t, value: last.k })
    dSeries.update({ time: t, value: last.d })
    jSeries.update({ time: t, value: last.j })
  },
}
