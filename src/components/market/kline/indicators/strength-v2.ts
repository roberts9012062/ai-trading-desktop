/**
 * 强弱指标 V2「形态档」副图注册项：0–100 蜡烛 + 50 中轴 + 0/100 边界
 * + 六档双向箭头（多=belowBar↑红 / 空=aboveBar↓绿）
 *
 * 计算内核 lib/strength-v2.ts（与后端 signal_strength_v2.py 逐位同源）。
 * 与 V1（strength.ts）经 isEnabled 互斥分流：本项须
 * strengthV2.enabled 且 strengthVersion==="v2" 才生效（6.1 版本分发）。
 *
 * 渲染层口径与 V1 一致（不动内核值，保证前后端 fixture 对齐）：
 * - 写入蜡烛时钳制影线包住实体（平滑 open 急反转可越出 high/low）
 * - 价格轴范围固定 0..100（autoscaleInfoProvider）
 * - 双向箭头需要上下余量，轴边距用 subScaleMarginsArrowPad()（上下各 30%）
 *   （V1 只有 belowBar 箭头，沿用 subScaleMargins() 不变）
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
  calcStrengthV2,
  type StrengthV2Params,
} from "@/lib/strength-v2"
import type { IndicatorConfig } from "@/types/indicator"
import type { KlineBar, KlinePeriod } from "@/types"
import { formatChartTime, prepareBars } from "../utils"
import { subScaleMarginsArrowPad } from "./pane-sizing"
import type { SubIndicatorDef, SubIndicatorHandle } from "./registry"

/** handle.series 固定顺序：蜡烛 / 50 中轴 / 100 上边界 / 0 下边界 */
type StrengthV2SeriesTuple = [
  ISeriesApi<"Candlestick">,
  ISeriesApi<"Line">,
  ISeriesApi<"Line">,
  ISeriesApi<"Line">,
]

/** 六档信号的箭头形态（6.2：多=belowBar↑，空=aboveBar↓；「中继」多空同名） */
const SIGNAL_MARKER: Record<string, { text: string; short: boolean }> = {
  bottom_exhaust: { text: "底部", short: false },
  rebound: { text: "反弹", short: false },
  continuation_long: { text: "中继", short: false },
  top_exhaust: { text: "顶部", short: true },
  breakdown: { text: "破位", short: true },
  continuation_short: { text: "中继", short: true },
}

/** 配置 → 计算参数（剥掉 enabled 与颜色，其余字段一一对应） */
function paramsFrom(cfg: IndicatorConfig["strengthV2"]): StrengthV2Params {
  return {
    period: cfg.period,
    smooth: cfg.smooth,
    smooth2: cfg.smooth2,
    continuationBand: cfg.continuationBand,
    exhaustWindow: cfg.exhaustWindow,
    shrinkRatio: cfg.shrinkRatio,
    flatEps: cfg.flatEps,
    zoneDrop: cfg.zoneDrop,
    priceBufferAtrMult: cfg.priceBufferAtrMult,
    atrPeriod: cfg.atrPeriod,
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
function tupleOf(h: SubIndicatorHandle): StrengthV2SeriesTuple | null {
  const [candle, mid, top, bottom] = h.series as StrengthV2SeriesTuple
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

/**
 * 衰竭档箭头回退到旧色的最后一根（用户验收口径）：
 * 顶部画在最后一根红柱上、底部画在最后一根绿柱上——即变色的边界柱/极值柱。
 * 检测仍在转色根确认（最后一根旧色柱在当时无法自知是最后一根，提前判定
 * 属未来函数），仅箭头位置回退；信号 index/因果语义不变，策略仍按检测根行动。
 */
function exhaustMarkerPoint(
  k: number,
  points: ReadonlyArray<{ time: string; close: number }>,
  dir: 1 | -1,
): { time: string } {
  // dir=1（顶部）：跳过阴/平柱（d ≤ 0），停在最后一根阳柱；dir=-1 镜像
  let j = k
  while (j > 1 && (points[j].close - points[j - 1].close) * dir <= 0) j--
  return points[j]
}

/** 信号 → markers（pending 的末根信号不画，收盘确认后才出现） */
function buildMarkers(
  signals: ReadonlyArray<{ time: string; kind: string; pending: boolean; index: number }>,
  period: KlinePeriod,
  longColor: string,
  shortColor: string,
  points: ReadonlyArray<{ time: string; close: number }>,
  firstBarIndex: number,
): SeriesMarker<Time>[] {
  const markers: SeriesMarker<Time>[] = []
  for (const s of signals) {
    if (s.pending) continue
    const m = SIGNAL_MARKER[s.kind]
    if (!m) continue
    const isExhaust = s.kind === "bottom_exhaust" || s.kind === "top_exhaust"
    const anchor = isExhaust
      ? exhaustMarkerPoint(s.index - firstBarIndex, points, m.short ? 1 : -1)
      : s
    markers.push({
      time: formatChartTime(period, anchor.time),
      position: m.short ? "aboveBar" : "belowBar",
      color: m.short ? shortColor : longColor,
      shape: m.short ? "arrowDown" : "arrowUp",
      text: m.text,
    })
  }
  return markers
}

export const STRENGTH_V2_DEF: SubIndicatorDef = {
  id: "strengthV2",
  label: "强弱V2",
  isEnabled: (cfg: IndicatorConfig): boolean =>
    cfg.strengthV2.enabled && cfg.strengthVersion === "v2",

  createSeries: (
    chart: IChartApi,
    cfg: IndicatorConfig,
    paneIndex: number,
  ): SubIndicatorHandle => {
    const s = cfg.strengthV2
    // 价格轴固定 0..100：四条 series 共用同一 provider，并集恒为 [0,100]
    const fixedScale = () => ({ priceRange: { minValue: 0, maxValue: 100 } })
    const lineOpts = {
      lineWidth: 1 as const,
      priceLineVisible: false,
      lastValueVisible: false,
      priceScaleId: "strengthV2",
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
        priceScaleId: "strengthV2",
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
    // 上下余量给双向箭头（V1 的 subScaleMargins 不动）
    chart.priceScale("strengthV2", paneIndex).applyOptions({
      scaleMargins: subScaleMarginsArrowPad(),
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
    const first = cfg.strengthV2.period - 1
    const res = calcStrengthV2(prepareBars(bars, period), paramsFrom(cfg.strengthV2))
    const times = res.points.map((p) => formatChartTime(period, p.time))
    candle.setData(
      res.points.map((p) =>
        toCandlePoint(period, p.time, p.open, p.high, p.low, p.close),
      ),
    )
    mid.setData(times.map((time) => ({ time, value: 50 })))
    top.setData(times.map((time) => ({ time, value: 100 })))
    bottom.setData(times.map((time) => ({ time, value: 0 })))
    h.markers?.setMarkers(
      buildMarkers(
        res.signals,
        period,
        cfg.strengthV2.longSignalColor,
        cfg.strengthV2.shortSignalColor,
        res.points,
        first,
      ),
    )
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
    const first = cfg.strengthV2.period - 1
    // 沿用既有指标口径：末点增量用原始 bars 全量重算，只回写末点
    const res = calcStrengthV2(bars, paramsFrom(cfg.strengthV2))
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
    h.markers?.setMarkers(
      buildMarkers(
        res.signals,
        period,
        cfg.strengthV2.longSignalColor,
        cfg.strengthV2.shortSignalColor,
        res.points,
        first,
      ),
    )
  },
}
