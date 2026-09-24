/**
 * 波段 markers 版本分派：按 pivotVersion 决定挂 V1 还是 V2
 *
 * 二选一语义：两版共用同一个 markers 插件 ref，setMarkers 整表替换，
 * 因此同一时刻图上只可能有一组箭头；切换版本时旧箭头自动被覆盖。
 * 当前版本未启用时对应的 apply 函数会清空并卸载插件。
 */

import type {
  ISeriesApi,
  ISeriesMarkersPluginApi,
  Time,
} from "lightweight-charts"
import type { KlineBar, KlinePeriod } from "@/types"
import type { IndicatorConfig } from "@/types/indicator"
import { PIVOT_V2_ENABLED } from "@/lib/pivot-signals-v2"
import { applyPivotMarkers, clearPivotMarkers } from "./pivot-markers"
import { applyPivotV2Markers } from "./pivot-v2-markers"

export { clearPivotMarkers }

/**
 * 生效的波段版本：PIVOT_V2_ENABLED=false 时一律 v1（存量 v2 存储配置不改、
 * 只在展示层回落）。图上 markers 与设置页共用这一口径。
 */
export function effectivePivotVersion(config: IndicatorConfig): "v1" | "v2" {
  return PIVOT_V2_ENABLED && config.pivotVersion === "v2" ? "v2" : "v1"
}

/** 按配置里的 pivotVersion 分派到 V1 / V2 的 markers 实现 */
export function applyPivotMarkersByVersion(
  series: ISeriesApi<"Candlestick"> | null,
  pluginRef: { current: ISeriesMarkersPluginApi<Time> | null },
  bars: KlineBar[],
  period: KlinePeriod,
  config: IndicatorConfig,
): void {
  if (effectivePivotVersion(config) === "v2") {
    if (!config.pivotV2) {
      clearPivotMarkers(pluginRef)
      return
    }
    applyPivotV2Markers(series, pluginRef, bars, period, config.pivotV2)
    return
  }
  if (!config.pivot) {
    clearPivotMarkers(pluginRef)
    return
  }
  applyPivotMarkers(series, pluginRef, bars, period, config.pivot)
}
