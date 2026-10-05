/**
 * 波段信号 markers 插件：波谷↑做多、波峰↓做空（支持盘中实时预确认）
 */

import {
  createSeriesMarkers,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type SeriesMarker,
  type Time,
} from "lightweight-charts"
import { calcChartPivotSignals } from "@/lib/pivot-signals"
import type { KlineBar, KlinePeriod } from "@/types"
import type { PivotSignalConfig } from "@/types/indicator"
import { formatChartTime } from "./utils"

/** 从配置构造过滤参数 */
function filterFromPivot(pivot: PivotSignalConfig) {
  return {
    alternate: pivot.alternate !== false,
    minAmplitudePct:
      typeof pivot.minAmplitudePct === "number" ? pivot.minAmplitudePct : 1.5,
    minAtrMult: typeof pivot.minAtrMult === "number" ? pivot.minAtrMult : 1.5,
    atrPeriod: typeof pivot.atrPeriod === "number" ? pivot.atrPeriod : 14,
    // 盘中至少 1 根右侧（含 forming）即可预确认；正式需满 right
    minRightLive:
      typeof pivot.minRightLive === "number" ? pivot.minRightLive : 1,
  }
}

/** 附着或更新 markers 插件；关闭时清空 */
export function applyPivotMarkers(
  series: ISeriesApi<"Candlestick"> | null,
  pluginRef: { current: ISeriesMarkersPluginApi<Time> | null },
  bars: KlineBar[],
  period: KlinePeriod,
  pivot: PivotSignalConfig,
): void {
  if (!series || period === "tick") {
    clearPivotMarkers(pluginRef)
    return
  }
  if (!pivot.enabled) {
    clearPivotMarkers(pluginRef)
    return
  }

  if (!pluginRef.current) {
    try {
      pluginRef.current = createSeriesMarkers(series, [])
    } catch {
      pluginRef.current = null
      return
    }
  }

  const signals = calcChartPivotSignals(
    // Older cached/feed rows have no flag. The chart's live tail is forming;
    // official OKX confirmation takes precedence when present.
    bars.length && bars.at(-1)?.is_closed == null
      ? [...bars.slice(0, -1), { ...bars[bars.length - 1], is_closed: false }]
      : bars,
    Math.max(1, Math.floor(pivot.left)),
    Math.max(1, Math.floor(pivot.right)),
    filterFromPivot(pivot),
  )
  // size 略小 + 主图 scaleMargins.top 留白，避免顶部「空」文字被裁切
  const markers: SeriesMarker<Time>[] = signals.map((s) => {
    const time = formatChartTime(period, s.time)
    // 预确认用「·」后缀，便于区分；破坏后整表重算会消失
    if (s.side === "long") {
      return {
        time,
        position: "belowBar",
        shape: "arrowUp",
        color: pivot.longColor,
        text: s.provisional ? "多·" : "多",
        size: 1,
      }
    }
    return {
      time,
      position: "aboveBar",
      shape: "arrowDown",
      color: pivot.shortColor,
      text: s.provisional ? "空·" : "空",
      size: 1,
    }
  })
  try {
    pluginRef.current.setMarkers(markers)
  } catch {
    // 时间不一致等：忽略单次
  }
}

/** 清空并卸载 markers 插件 */
export function clearPivotMarkers(pluginRef: {
  current: ISeriesMarkersPluginApi<Time> | null
}): void {
  if (!pluginRef.current) return
  try {
    pluginRef.current.setMarkers([])
    pluginRef.current.detach()
  } catch {
    /* ignore */
  }
  pluginRef.current = null
}
