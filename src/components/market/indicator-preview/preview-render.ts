/**
 * 指标示意图的各指标渲染器（示意图框架的「每个指标一份」部分）
 *
 * 在传入的 chart 上渲染主图蜡烛 + 当前 tab 的指标图形，并登记各图形元素的
 * 「闪烁脉冲」回调（preview-chart 触发，约 2 秒呼吸）。数据由调用方传入：
 * 行情页传真实 K 线（截尾），无数据时回落固定合成序列。高亮键词表（各 tab
 * 的表单字段声明 highlight 时使用）：ma / bollUpper / bollMiddle / bollLower /
 * dif / dea / histUp / histDown / rsi / overbought / oversold / k / d / j /
 * arrows / arrowLong / arrowShort / candles / midline / zone（强弱 V2 滞回带）
 */

import {
  CandlestickSeries,
  HistogramSeries,
  LineSeries,
  createSeriesMarkers,
  type IChartApi,
  type ISeriesApi,
  type SeriesMarker,
  type Time,
} from "lightweight-charts"
import { calcBOLL, calcKDJ, calcMACD, calcRSI, calcSMA } from "@/lib/indicators"
import { calcPivotSignals } from "@/lib/pivot-signals"
import type { IndicatorConfig } from "@/types/indicator"
import type { KlineBar, KlinePeriod } from "@/types"
import { formatChartTime } from "@/components/market/kline/utils"
import { renderStrengthPreview } from "./preview-strength"

/** 闪烁脉冲：on=true 高亮，on=false 恢复底色 */
export type FlashPulse = (on: boolean) => void

export interface PreviewRenderResult {
  dispose: () => void
  targets: Map<string, FlashPulse[]>
}

/** 预览渲染中可出现的 series 类型（强弱渲染模块共用） */
export type AnySeries = ISeriesApi<"Line" | "Candlestick" | "Histogram">

const FLASH = "#facc15"
const CANDLE_UP = "#ef4444"
const CANDLE_DOWN = "#22d3ee"
const SHORT_KINDS = new Set(["top_exhaust", "breakdown", "continuation_short"])
const EXHAUST_KINDS = new Set(["bottom_exhaust", "top_exhaust"])

export function withAlpha(hex: string, alpha: number): string {
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return hex
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `rgba(${r},${g},${b},${alpha})`
}

export function linePulse(line: ISeriesApi<"Line">, color: string, width: 1 | 2): FlashPulse {
  return (on) =>
    line.applyOptions(on ? { color: FLASH, lineWidth: 3 } : { color, lineWidth: width })
}

export function candlePulse(sc: ISeriesApi<"Candlestick">): FlashPulse {
  const restore = {
    upColor: CANDLE_UP, downColor: CANDLE_DOWN,
    borderUpColor: CANDLE_UP, borderDownColor: CANDLE_DOWN,
    wickUpColor: CANDLE_UP, wickDownColor: CANDLE_DOWN,
  }
  const flash = {
    upColor: FLASH, downColor: FLASH,
    borderUpColor: FLASH, borderDownColor: FLASH,
    wickUpColor: FLASH, wickDownColor: FLASH,
  }
  return (on) => sc.applyOptions(on ? flash : restore)
}

/** markers 脉冲：整体换色重建（数量小，代价可忽略） */
export function markerPulse(
  owner: ISeriesApi<"Candlestick">,
  markers: SeriesMarker<Time>[],
  baseColor: (m: SeriesMarker<Time>) => string,
): FlashPulse {
  const plugin = createSeriesMarkers(owner, [])
  const redraw = (flash: string | null) =>
    plugin.setMarkers(markers.map((m) => ({ ...m, color: flash ?? baseColor(m) })))
  redraw(null)
  return (on) => redraw(on ? FLASH : null)
}

/**
 * 渲染主图蜡烛 + 当前 tab 指标；返回清理函数与闪烁目标。
 * tab ∈ ma / boll / macd / rsi / jdk / pivot / strength（pivot 与 strength
 * 内部按版本取对应配置；波段 V2 暂停期间像其 tab 一样回落 V1）。
 * bars 为真实 K 线截尾或合成回落序列；period 用于时间轴归一（日线取日期
 * 字符串，分钟线转时间戳，与主图 formatChartTime 同口径）。
 */
export function renderIndicatorPreview(
  chart: IChartApi,
  cfg: IndicatorConfig,
  tab: string,
  bars: KlineBar[],
  period: KlinePeriod,
): PreviewRenderResult {
  const series: AnySeries[] = []
  const targets = new Map<string, FlashPulse[]>()
  const toTime = (t: string): Time => formatChartTime(period, t)
  const times = bars.map((b) => toTime(b.time))
  const pane0 = 0

  const candle = chart.addSeries(CandlestickSeries, {
    upColor: CANDLE_UP, downColor: CANDLE_DOWN,
    borderUpColor: CANDLE_UP, borderDownColor: CANDLE_DOWN,
    wickUpColor: CANDLE_UP, wickDownColor: CANDLE_DOWN,
    priceLineVisible: false, lastValueVisible: false,
  })
  candle.setData(
    bars.map((b) => ({ time: toTime(b.time), open: b.open, high: b.high, low: b.low, close: b.close })),
  )
  series.push(candle)
  targets.set("main", [candlePulse(candle)])

  const addLine = (color: string, paneIndex: number, width: 1 | 2 = 1) => {
    const line = chart.addSeries(
      LineSeries,
      { color, lineWidth: width, priceLineVisible: false, lastValueVisible: false },
      paneIndex,
    )
    series.push(line)
    return line
  }
  const sub = () => chart.addPane().paneIndex()

  if (tab === "ma") {
    for (const line of cfg.maLines) {
      const l = addLine(line.color, pane0, 2)
      l.setData(calcSMA(bars, line.period).map((p) => ({ time: toTime(p.time), value: p.value })))
      const list = targets.get("ma") ?? []
      list.push(linePulse(l, line.color, 2))
      targets.set("ma", list)
    }
  } else if (tab === "boll") {
    const pts = calcBOLL(bars, cfg.boll.period, cfg.boll.std)
    const defs = [
      ["bollUpper", cfg.boll.upperColor, (p: (typeof pts)[number]) => p.upper],
      ["bollMiddle", cfg.boll.middleColor, (p: (typeof pts)[number]) => p.middle],
      ["bollLower", cfg.boll.lowerColor, (p: (typeof pts)[number]) => p.lower],
    ] as const
    for (const [key, color, pick] of defs) {
      const l = addLine(color, pane0, 2)
      l.setData(pts.map((p) => ({ time: toTime(p.time), value: pick(p) })))
      targets.set(key, [linePulse(l, color, 2)])
    }
  } else if (tab === "macd") {
    const pane = sub()
    const m = cfg.macd
    const pts = calcMACD(bars, m.fastPeriod, m.slowPeriod, m.signalPeriod)
    const hist = chart.addSeries(HistogramSeries, { priceLineVisible: false, lastValueVisible: false }, pane)
    series.push(hist)
    const drawHist = (flash: boolean) =>
      hist.setData(
        pts.map((p) => ({
          time: toTime(p.time),
          value: p.macd,
          color: flash ? FLASH : p.macd >= 0 ? m.histUpColor : m.histDownColor,
        })),
      )
    drawHist(false)
    const dif = addLine(m.difColor, pane, 2)
    dif.setData(pts.map((p) => ({ time: toTime(p.time), value: p.dif })))
    const dea = addLine(m.deaColor, pane)
    dea.setData(pts.map((p) => ({ time: toTime(p.time), value: p.dea })))
    targets.set("dif", [linePulse(dif, m.difColor, 2)])
    targets.set("dea", [linePulse(dea, m.deaColor, 1)])
    targets.set("histUp", [drawHist])
    targets.set("histDown", [drawHist])
  } else if (tab === "rsi") {
    const pane = sub()
    const r = cfg.rsi
    const rsi = addLine(r.lineColor, pane, 2)
    rsi.setData(calcRSI(bars, r.period).map((p) => ({ time: toTime(p.time), value: p.value })))
    const ob = addLine(r.overboughtColor, pane)
    ob.setData(times.map((time) => ({ time, value: r.overbought })))
    const os = addLine(r.oversoldColor, pane)
    os.setData(times.map((time) => ({ time, value: r.oversold })))
    targets.set("rsi", [linePulse(rsi, r.lineColor, 2)])
    targets.set("overbought", [linePulse(ob, r.overboughtColor, 1)])
    targets.set("oversold", [linePulse(os, r.oversoldColor, 1)])
  } else if (tab === "jdk") {
    const pane = sub()
    const j = cfg.jdk
    const pts = calcKDJ(bars, j.rsvPeriod, j.kPeriod, j.dPeriod)
    const defs = [
      ["k", j.kColor, (p: (typeof pts)[number]) => p.k, 2],
      ["d", j.dColor, (p: (typeof pts)[number]) => p.d, 2],
      ["j", j.jColor, (p: (typeof pts)[number]) => p.j, 1],
    ] as const
    for (const [key, color, pick, width] of defs) {
      const l = addLine(color, pane, width)
      l.setData(pts.map((p) => ({ time: toTime(p.time), value: pick(p) })))
      targets.set(key, [linePulse(l, color, width)])
    }
  } else if (tab === "pivot") {
    const p = cfg.pivot
    const signals = calcPivotSignals(bars, p.left, p.right, {
      alternate: p.alternate,
      minAmplitudePct: p.minAmplitudePct,
      minAtrMult: p.minAtrMult,
      atrPeriod: p.atrPeriod,
      minRightLive: p.right,
    })
    const markers: SeriesMarker<Time>[] = signals
      .filter((s) => !s.provisional)
      .map((s) => ({
        time: toTime(s.time),
        position: s.side === "long" ? "belowBar" : "aboveBar",
        shape: s.side === "long" ? "arrowUp" : "arrowDown",
        color: "",
        text: "",
      }))
    const pulse = markerPulse(candle, markers, (m) =>
      m.position === "belowBar" ? p.longColor : p.shortColor,
    )
    targets.set("arrows", [pulse])
    targets.set("arrowLong", [pulse])
    targets.set("arrowShort", [pulse])
  } else if (tab === "strength") {
    renderStrengthPreview(chart, cfg, {
      sub, addLine, series, targets, mainCandle: candle, bars, toTime,
    })
  }

  return {
    dispose: () => {
      for (const s of series) {
        try {
          chart.removeSeries(s)
        } catch {
          /* series 可能已随 pane 回收 */
        }
      }
    },
    targets,
  }
}
