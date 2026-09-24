/**
 * 强弱指标副图注册项：0–100 蜡烛 + 50 中轴 + 0/100 边界 + 三档进场箭头
 * 计算内核 lib/strength-index.ts（与后端 signal_strength.py 逐位同源）。
 *
 * 渲染层两个口径（不动内核值，保证前后端 fixture 对齐）：
 * - 写入蜡烛时钳制影线包住实体：平滑 open 在急反转处可能越出 high/low，
 *   lightweight-charts 要求 high ≥ max(open,close)、low ≤ min(open,close)
 * - 价格轴范围固定 0..100（autoscaleInfoProvider），避免中段数据被拉伸
 */

import {
  CandlestickSeries,
  LineSeries,
  createSeriesMarkers,
  type IChartApi,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type SeriesMarker,
  type Time,
} from "lightweight-charts"
import {
  calcStrength,
  type StrengthParams,
} from "@/lib/strength-index"
import type { IndicatorConfig } from "@/types/indicator"
import type { KlineBar, KlinePeriod } from "@/types"
import { formatChartTime, prepareBars } from "../utils"
import { subScaleMargins } from "./pane-sizing"
import type { SubIndicatorDef, SubIndicatorHandle } from "./registry"

/** handle.series 固定顺序：蜡烛 / 50 中轴 / 100 上边界 / 0 下边界 */
type StrengthSeriesTuple = [
  ISeriesApi<"Candlestick">,
  ISeriesApi<"Line">,
  ISeriesApi<"Line">,
  ISeriesApi<"Line">,
]

/** 三档信号的箭头文案 */
const SIGNAL_TEXT: Record<string, string> = {
  swing: "波段",
  rebound: "反弹",
  deep: "超跌",
}

/** 配置 → 计算参数（剥掉 enabled 与颜色，其余字段一一对应） */
function paramsFrom(cfg: IndicatorConfig["strength"]): StrengthParams {
  return {
    period: cfg.period,
    smooth: cfg.smooth,
    smooth2: cfg.smooth2,
    trendMaPeriod: cfg.trendMaPeriod,
    swingThreshold: cfg.swingThreshold,
    reboundThreshold: cfg.reboundThreshold,
    oversoldLevel: cfg.oversoldLevel,
    reboundLookback: cfg.reboundLookback,
    deepLevel: cfg.deepLevel,
    deepBars: cfg.deepBars,
    cooldown: cfg.cooldown,
  }
}

/** hex(#rrggbb) → rgba；非 hex 原样返回（边界线低透明度用） */
function hexToRgba(hex: string, alpha: number): string {
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return hex
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `rgba(${r},${g},${b},${alpha})`
}

/** 从 handle 取回固定顺序的四条 series（创建方保证顺序） */
function tupleOf(h: SubIndicatorHandle): StrengthSeriesTuple | null {
  const [candle, mid, top, bottom] = h.series as StrengthSeriesTuple
  if (!candle || !mid || !top || !bottom) return null
  return [candle, mid, top, bottom]
}

/** 蜡烛点：钳制影线包住实体（渲染层口径，内核值不动） */
function toCandlePoint(period: KlinePeriod, time: string, o: number, h: number, l: number, c: number) {
  return {
    time: formatChartTime(period, time),
    open: o,
    close: c,
    high: Math.max(h, o, c),
    low: Math.min(l, o, c),
  }
}

/** 信号 → markers（pending 的末根信号不画，收盘确认后才出现） */
function buildMarkers(
  signals: ReadonlyArray<{ time: string; kind: string; pending: boolean }>,
  period: KlinePeriod,
  color: string,
): SeriesMarker<Time>[] {
  const markers: SeriesMarker<Time>[] = []
  for (const s of signals) {
    if (s.pending) continue
    markers.push({
      time: formatChartTime(period, s.time),
      position: "belowBar",
      color,
      shape: "arrowUp",
      text: SIGNAL_TEXT[s.kind] ?? s.kind,
    })
  }
  return markers
}

export const STRENGTH_DEF: SubIndicatorDef = {
  id: "strength",
  label: "强弱",
  // 版本分流（6.1）：默认 "v1"，存量用户行为不变；与 STRENGTH_V2_DEF 的
  // isEnabled 天然互斥，同一时刻只渲染一个版本的副图
  isEnabled: (cfg: IndicatorConfig): boolean =>
    cfg.strength.enabled && cfg.strengthVersion === "v1",

  createSeries: (
    chart: IChartApi,
    cfg: IndicatorConfig,
    paneIndex: number,
  ): SubIndicatorHandle => {
    const s = cfg.strength
    // 价格轴固定 0..100：四条 series 共用同一 provider，并集恒为 [0,100]
    const fixedScale = () => ({ priceRange: { minValue: 0, maxValue: 100 } })
    const lineOpts = {
      lineWidth: 1 as const,
      priceLineVisible: false,
      lastValueVisible: false,
      priceScaleId: "strength",
      autoscaleInfoProvider: fixedScale,
    }
    const candle = chart.addSeries(
      CandlestickSeries,
      {
        upColor: s.upColor,
        downColor: s.downColor,
        borderUpColor: s.upColor,
        borderDownColor: s.downColor,
        wickUpColor: s.upColor,
        wickDownColor: s.downColor,
        priceScaleId: "strength",
        autoscaleInfoProvider: fixedScale,
      },
      paneIndex,
    )
    const mid = chart.addSeries(
      LineSeries,
      { ...lineOpts, color: s.midLineColor },
      paneIndex,
    )
    const top = chart.addSeries(
      LineSeries,
      { ...lineOpts, color: hexToRgba(s.midLineColor, 0.3), lineStyle: 2 },
      paneIndex,
    )
    const bottom = chart.addSeries(
      LineSeries,
      { ...lineOpts, color: hexToRgba(s.midLineColor, 0.3), lineStyle: 2 },
      paneIndex,
    )
    chart.priceScale("strength", paneIndex).applyOptions({
      scaleMargins: subScaleMargins(),
      visible: false,
    })
    return {
      series: [candle, mid, top, bottom],
      markers: createSeriesMarkers(candle, []),
      paneIndex,
    }
  },

  setData: (
    h: SubIndicatorHandle,
    bars: KlineBar[],
    period: KlinePeriod,
    cfg: IndicatorConfig,
  ): void => {
    const t = tupleOf(h)
    if (!t) return
    const [candle, mid, top, bottom] = t
    const res = calcStrength(prepareBars(bars, period), paramsFrom(cfg.strength))
    const times = res.points.map((p) => formatChartTime(period, p.time))
    candle.setData(
      res.points.map((p) =>
        toCandlePoint(period, p.time, p.open, p.high, p.low, p.close),
      ),
    )
    mid.setData(times.map((time) => ({ time, value: 50 })))
    top.setData(times.map((time) => ({ time, value: 100 })))
    bottom.setData(times.map((time) => ({ time, value: 0 })))
    h.markers?.setMarkers(buildMarkers(res.signals, period, cfg.strength.signalColor))
  },

  updateLast: (
    h: SubIndicatorHandle,
    bars: KlineBar[],
    period: KlinePeriod,
    cfg: IndicatorConfig,
  ): void => {
    const t = tupleOf(h)
    if (!t) return
    const [candle, mid, top, bottom] = t
    // 沿用既有指标口径：末点增量用原始 bars 全量重算，只回写末点
    const res = calcStrength(bars, paramsFrom(cfg.strength))
    const last = res.points[res.points.length - 1]
    if (!last) return
    const time = formatChartTime(period, last.time)
    try {
      candle.update(toCandlePoint(period, last.time, last.open, last.high, last.low, last.close))
      mid.update({ time, value: 50 })
      top.update({ time, value: 100 })
      bottom.update({ time, value: 0 })
    } catch {
      /* 时间不一致时忽略单次 update */
    }
    h.markers?.setMarkers(buildMarkers(res.signals, period, cfg.strength.signalColor))
  },
}
