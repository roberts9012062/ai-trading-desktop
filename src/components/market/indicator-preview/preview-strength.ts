/**
 * 指标示意图 —— 强弱（V1/V2）副图渲染（自 preview-render.ts 拆出守 300 行）
 *
 * 副图蜡烛 + 中轴与 V2 滞回带 + 信号箭头（衰竭档箭头锚点回退到旧色最后
 * 一根，与图表口径一致）。bars 与时间转换由 ctx 传入（真实 K 线或合成
 * 回落序列）。词表：candles / midline / zone / arrows / arrowLong / arrowShort。
 */

import {
  CandlestickSeries,
  type IChartApi,
  type ISeriesApi,
  type SeriesMarker,
  type Time,
} from "lightweight-charts"
import { calcStrength } from "@/lib/strength-index"
import { calcStrengthV2 } from "@/lib/strength-v2"
import type { IndicatorConfig } from "@/types/indicator"
import type { KlineBar } from "@/types"
import {
  candlePulse,
  linePulse,
  markerPulse,
  withAlpha,
  type AnySeries,
  type FlashPulse,
} from "./preview-render"

const FLASH = "#facc15"
const SHORT_KINDS = new Set(["top_exhaust", "breakdown", "continuation_short"])
const EXHAUST_KINDS = new Set(["bottom_exhaust", "top_exhaust"])

export interface StrengthPreviewCtx {
  sub: () => number
  addLine: (color: string, paneIndex: number, width?: 1 | 2) => ISeriesApi<"Line">
  series: AnySeries[]
  targets: Map<string, FlashPulse[]>
  mainCandle: ISeriesApi<"Candlestick">
  /** 预览数据（真实 K 线截尾或合成回落序列） */
  bars: KlineBar[]
  /** bar 时间 → 图表时间（与主图 formatChartTime 同口径） */
  toTime: (t: string) => Time
}

/** 强弱副图入口：按 strengthVersion 分派 V1/V2 */
export function renderStrengthPreview(
  chart: IChartApi,
  cfg: IndicatorConfig,
  ctx: StrengthPreviewCtx,
): void {
  if (cfg.strengthVersion === "v2") {
    renderStrengthV2(chart, cfg, ctx)
  } else {
    renderStrengthV1(chart, cfg, ctx)
  }
}


function drawStrengthPane(
  chart: IChartApi,
  pane: number,
  points: Array<{ time: string; open: number; high: number; low: number; close: number }>,
  upColor: string,
  downColor: string,
  midColor: string,
  toTime: (t: string) => Time,
  addLine: (color: string, paneIndex: number, width?: 1 | 2) => ISeriesApi<"Line">,
  series: AnySeries[],
  targets: Map<string, FlashPulse[]>,
): void {
  const sc = chart.addSeries(CandlestickSeries, {
    upColor, downColor, borderUpColor: upColor, borderDownColor: downColor,
    wickUpColor: upColor, wickDownColor: downColor,
    priceLineVisible: false, lastValueVisible: false,
  }, pane)
  sc.setData(
    points.map((p) => ({
      time: toTime(p.time),
      open: p.open,
      high: Math.max(p.high, p.open, p.close),
      low: Math.min(p.low, p.open, p.close),
      close: p.close,
    })),
  )
  series.push(sc)
  targets.set("candles", [candlePulse(sc)])
  const mid = addLine(midColor, pane)
  mid.setData(points.map((p) => ({ time: toTime(p.time), value: 50 })))
  targets.set("midline", [linePulse(mid, midColor, 1)])
}

function renderStrengthV1(
  chart: IChartApi,
  cfg: IndicatorConfig,
  ctx: StrengthPreviewCtx,
): void {
  const s = cfg.strength
  const res = calcStrength(ctx.bars, {
    period: s.period, smooth: s.smooth, smooth2: s.smooth2,
    trendMaPeriod: s.trendMaPeriod, swingThreshold: s.swingThreshold,
    reboundThreshold: s.reboundThreshold, oversoldLevel: s.oversoldLevel,
    reboundLookback: s.reboundLookback, deepLevel: s.deepLevel,
    deepBars: s.deepBars, cooldown: s.cooldown,
  })
  drawStrengthPane(chart, ctx.sub(), res.points, s.upColor, s.downColor, s.midLineColor, ctx.toTime, ctx.addLine, ctx.series, ctx.targets)
}

function renderStrengthV2(
  chart: IChartApi,
  cfg: IndicatorConfig,
  ctx: StrengthPreviewCtx,
): void {
  const s = cfg.strengthV2
  const res = calcStrengthV2(ctx.bars, {
    period: s.period, smooth: s.smooth, smooth2: s.smooth2,
    continuationBand: s.continuationBand, exhaustWindow: s.exhaustWindow,
    shrinkRatio: s.shrinkRatio, flatEps: s.flatEps, zoneDrop: s.zoneDrop,
    priceBufferAtrMult: s.priceBufferAtrMult, atrPeriod: s.atrPeriod, cooldown: s.cooldown,
  })
  const pane = ctx.sub()
  drawStrengthPane(chart, pane, res.points, s.upColor, s.downColor, s.midLineColor, ctx.toTime, ctx.addLine, ctx.series, ctx.targets)
  // 滞回带（示意层独有：50±band 两条淡色参考线，改带宽即闪烁）
  const bandColor = withAlpha(s.midLineColor, 0.45)
  const upper = ctx.addLine(bandColor, pane)
  upper.setData(res.points.map((p) => ({ time: ctx.toTime(p.time), value: 50 + s.continuationBand })))
  const lower = ctx.addLine(bandColor, pane)
  lower.setData(res.points.map((p) => ({ time: ctx.toTime(p.time), value: 50 - s.continuationBand })))
  ctx.targets.set("zone", [
    (on) => {
      const c = on ? FLASH : bandColor
      upper.applyOptions({ color: c, lineWidth: on ? 3 : 1 })
      lower.applyOptions({ color: c, lineWidth: on ? 3 : 1 })
    },
  ])
  // 信号箭头：衰竭档锚点回退到旧色最后一根（与图表口径一致）
  const closes = res.points.map((p) => p.close)
  const markers: SeriesMarker<Time>[] = []
  for (const sig of res.signals) {
    if (sig.pending) continue
    const short = SHORT_KINDS.has(sig.kind)
    let k = sig.index - (s.period - 1)
    if (EXHAUST_KINDS.has(sig.kind)) {
      const dir = short ? 1 : -1
      while (k > 1 && (closes[k] - closes[k - 1]) * dir <= 0) k--
    }
    markers.push({
      time: ctx.toTime(res.points[k].time),
      position: short ? "aboveBar" : "belowBar",
      shape: short ? "arrowDown" : "arrowUp",
      color: "",
      text: "",
    })
  }
  const pulse = markerPulse(ctx.mainCandle, markers, (m) =>
    m.position === "belowBar" ? s.longSignalColor : s.shortSignalColor,
  )
  ctx.targets.set("arrows", [pulse])
  ctx.targets.set("arrowLong", [pulse])
  ctx.targets.set("arrowShort", [pulse])
}
