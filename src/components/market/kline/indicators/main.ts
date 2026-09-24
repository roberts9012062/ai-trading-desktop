/**
 * 主图 series（蜡烛 / 成交量 / 均线 / 布林带）创建与数据写入
 * 迁移自 series-data.ts + use-chart-series.ts，写入行为逐位不变。
 * 副图指标（MACD/RSI/JDK/强弱）见同目录 registry.ts。
 */

import {
  CandlestickSeries,
  HistogramSeries,
  LineSeries,
  type IChartApi,
  type ISeriesApi,
} from "lightweight-charts"
import { calcBOLL, calcSMA } from "@/lib/indicators"
import { toChartLineStyle } from "@/types/indicator"
import type { IndicatorConfig } from "@/types/indicator"
import type { KlineBar, KlinePeriod } from "@/types"
import { formatChartTime, prepareBars } from "../utils"
import {
  volumeScaleMargins,
} from "./pane-sizing"
import {
  clearSubIndicators,
  writeSubIndicatorsData,
  type SubIndicatorHandle,
  type SubIndicatorId,
} from "./registry"

/** 布林带三条 series：上轨 / 中轨 / 下轨 */
export type BollSeriesRefs = [
  ISeriesApi<"Line"> | null,
  ISeriesApi<"Line"> | null,
  ISeriesApi<"Line"> | null,
]

/** 创建蜡烛 series（涨跌颜色由显示设置自定义） */
export function createCandleSeries(
  chart: IChartApi,
  candleUp: string,
  candleDown: string,
): ISeriesApi<"Candlestick"> {
  return chart.addSeries(CandlestickSeries, {
    upColor: candleUp,
    downColor: candleDown,
    borderUpColor: candleUp,
    borderDownColor: candleDown,
    wickUpColor: candleUp,
    wickDownColor: candleDown,
  })
}

/** 创建成交量 series（叠加主图底部，独立 overlay 轴） */
export function createVolumeSeries(
  chart: IChartApi,
): ISeriesApi<"Histogram"> {
  const vol = chart.addSeries(HistogramSeries, {
    priceFormat: { type: "volume" },
    priceScaleId: "volume",
  })
  vol.priceScale().applyOptions({ scaleMargins: volumeScaleMargins() })
  return vol
}

/** 按配置创建均线 series 列表 */
export function createMaSeriesList(
  chart: IChartApi,
  maLines: IndicatorConfig["maLines"],
): ISeriesApi<"Line">[] {
  const list: ISeriesApi<"Line">[] = []
  for (const ma of maLines) {
    list.push(
      chart.addSeries(LineSeries, {
        color: ma.color,
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
      }),
    )
  }
  return list
}

/** 创建布林带三轨 series */
export function createBollSeries(
  chart: IChartApi,
  boll: IndicatorConfig["boll"],
): BollSeriesRefs {
  // 三轨共用同一组基础选项，仅颜色与线型不同
  const lineOf = (color: string, style: ReturnType<typeof toChartLineStyle>) =>
    chart.addSeries(LineSeries, {
      color, lineWidth: 1, lineStyle: style,
      priceLineVisible: false, lastValueVisible: false,
    })
  return [
    lineOf(boll.upperColor, toChartLineStyle(boll.upperStyle)),
    lineOf(boll.middleColor, toChartLineStyle(boll.middleStyle)),
    lineOf(boll.lowerColor, toChartLineStyle(boll.lowerStyle)),
  ]
}

/** 写入蜡烛 + 成交量 */
export function setCandleAndVolumeData(
  series: ISeriesApi<"Candlestick">,
  volume: ISeriesApi<"Histogram">,
  bars: KlineBar[],
  period: KlinePeriod,
): void {
  const clean = prepareBars(bars, period)
  series.setData(
    clean.map((k) => ({
      time: formatChartTime(period, k.time),
      open: k.open,
      high: k.high,
      low: k.low,
      close: k.close,
    })),
  )
  volume.setData(
    clean.map((k) => ({
      time: formatChartTime(period, k.time),
      value: k.volume,
      color: k.close >= k.open ? "rgba(239,68,68,0.3)" : "rgba(34,197,94,0.3)",
    })),
  )
}

/** 写入均线并返回图例标签 */
export function setMaSeriesData(
  maSeriesList: ISeriesApi<"Line">[],
  bars: KlineBar[],
  period: KlinePeriod,
  maLines: IndicatorConfig["maLines"],
): string[] {
  const labels: string[] = []
  const clean = prepareBars(bars, period)
  for (let i = 0; i < maLines.length; i++) {
    const maConfig = maLines[i]
    const maSeries = maSeriesList[i]
    if (!maConfig || !maSeries) continue
    const data = calcSMA(clean, maConfig.period)
    if (data.length > 0) {
      try {
        maSeries.setData(
          data.map((d) => ({
            time: formatChartTime(period, d.time),
            value: d.value,
          })),
        )
        labels.push(`MA${maConfig.period}: ${data[data.length - 1].value}`)
      } catch {
        // setData 失败时清空，避免残留上一品种的均线（表现为竖线掉到 0）
        try {
          maSeries.setData([])
        } catch {
          /* ignore */
        }
      }
    } else {
      try {
        maSeries.setData([])
      } catch {
        /* ignore */
      }
    }
  }
  return labels
}

/** 写入布林带三轨 */
export function setBollSeriesData(
  bollSeries: BollSeriesRefs,
  bars: KlineBar[],
  period: KlinePeriod,
  boll: IndicatorConfig["boll"],
): void {
  const [upper, middle, lower] = bollSeries
  if (!upper || !middle || !lower) return
  const clean = prepareBars(bars, period)
  const data = calcBOLL(clean, boll.period, boll.std)
  if (data.length === 0) return
  upper.setData(
    data.map((d) => ({ time: formatChartTime(period, d.time), value: d.upper })),
  )
  middle.setData(
    data.map((d) => ({ time: formatChartTime(period, d.time), value: d.middle })),
  )
  lower.setData(
    data.map((d) => ({ time: formatChartTime(period, d.time), value: d.lower })),
  )
}

/** 实时增量更新均线末点 */
export function updateMaLastPoints(
  maSeriesList: ISeriesApi<"Line">[],
  bars: KlineBar[],
  period: KlinePeriod,
  maLines: IndicatorConfig["maLines"],
): void {
  const clean = prepareBars(bars, period)
  for (let i = 0; i < maLines.length; i++) {
    const maConfig = maLines[i]
    const maSeries = maSeriesList[i]
    if (!maSeries || !maConfig) continue
    const data = calcSMA(clean, maConfig.period)
    const lastPoint = data[data.length - 1]
    if (lastPoint) {
      try {
        maSeries.update({
          time: formatChartTime(period, lastPoint.time),
          value: lastPoint.value,
        })
      } catch {
        /* 时间不一致时忽略单次 update */
      }
    }
  }
}

/** 实时增量更新布林带末点 */
export function updateBollLastPoints(
  bollSeries: BollSeriesRefs,
  bars: KlineBar[],
  period: KlinePeriod,
  boll: IndicatorConfig["boll"],
): void {
  const [upper, middle, lower] = bollSeries
  if (!upper || !middle || !lower) return
  // 沿用迁移前口径：末点增量更新直接用原始 bars，不做写入前清洗
  const data = calcBOLL(bars, boll.period, boll.std)
  const last = data[data.length - 1]
  if (!last) return
  const t = formatChartTime(period, last.time)
  upper.update({ time: t, value: last.upper })
  middle.update({ time: t, value: last.middle })
  lower.update({ time: t, value: last.lower })
}

/** 主图 + 全部副图一次写入（波段 markers 由调用方另行挂载） */
export function writeMainAndSubData(args: {
  series: ISeriesApi<"Candlestick">
  volume: ISeriesApi<"Histogram">
  maSeriesList: ISeriesApi<"Line">[]
  bollSeries: BollSeriesRefs
  subHandles: Map<SubIndicatorId, SubIndicatorHandle>
  bars: KlineBar[]
  period: KlinePeriod
  config: IndicatorConfig
  setMaLabels: (labels: string[]) => void
}): void {
  setCandleAndVolumeData(args.series, args.volume, args.bars, args.period)
  args.setMaLabels(
    setMaSeriesData(
      args.maSeriesList,
      args.bars,
      args.period,
      args.config.maLines,
    ),
  )
  if (args.config.boll.enabled) {
    setBollSeriesData(
      args.bollSeries,
      args.bars,
      args.period,
      args.config.boll,
    )
  }
  writeSubIndicatorsData(
    args.subHandles,
    args.bars,
    args.period,
    args.config,
  )
}

/** 清空主图 + 全部副图 series 数据（切到无数据合约时清残影用） */
export function clearMainAndSubData(args: {
  series: ISeriesApi<"Candlestick">
  volume: ISeriesApi<"Histogram">
  maSeriesList: ISeriesApi<"Line">[]
  bollSeries: BollSeriesRefs
  subHandles: Map<SubIndicatorId, SubIndicatorHandle>
}): void {
  const clearAny = (s: ISeriesApi<"Line" | "Histogram" | "Candlestick"> | null) => {
    if (!s) return
    try {
      s.setData([])
    } catch {
      /* ignore */
    }
  }
  clearAny(args.series)
  clearAny(args.volume)
  for (const s of args.maSeriesList) clearAny(s)
  args.bollSeries.forEach(clearAny)
  clearSubIndicators(args.subHandles)
}
