/**
 * 波段信号 V2 markers 插件：前期低点拒绝↑做多、前期高点拒绝↓做空
 *
 * 与 V1（pivot-markers.ts）的差异（2026-08-30 重做，算法见
 * lib/pivot-signals-v2.ts）：
 * - 信号在前期高低点处出现量价拒绝（放量影线 / 缩量多K失败）即刻触发，
 *   不等右侧确认；箭头文案区分触发形态：多放/空放=放量拒绝、多缩/空缩=缩量失败；
 * - 假信号：参考极值被突破的箭头灰显带 ✕（hideInvalidated 可改为直接隐藏）。
 *   满屏 ✕ 不是 bug，是信号真实生命周期的呈现（可开启隐藏）；
 * - 触发只评已收盘 bar，盘中形成中的 K 线不会造成箭头闪烁。
 *
 * V1 插件保持不变，两者由 pivotVersion 二选一，同一时刻只挂一个。
 */

import {
  createSeriesMarkers,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type SeriesMarker,
  type Time,
} from "lightweight-charts"
import { calcPivotSignalsV2 } from "@/lib/pivot-signals-v2"
import type { KlineBar, KlinePeriod } from "@/types"
import type { PivotV2Config } from "@/types/indicator"
import { clearPivotMarkers } from "./pivot-markers"
import { formatChartTime } from "./utils"

/** 从配置构造 V2 拒绝形态参数（缺字段回落默认，兼容旧 localStorage） */
function optionsFromPivotV2(pivot: PivotV2Config) {
  return {
    proximityAtrMult:
      typeof pivot.proximityAtrMult === "number" ? pivot.proximityAtrMult : 1.0,
    wickAtrMult:
      typeof pivot.wickAtrMult === "number" ? pivot.wickAtrMult : 0.8,
    attackWindow:
      typeof pivot.attackWindow === "number" ? pivot.attackWindow : 3,
    volExpandRatio:
      typeof pivot.volExpandRatio === "number" ? pivot.volExpandRatio : 1.5,
    volShrinkRatio:
      typeof pivot.volShrinkRatio === "number" ? pivot.volShrinkRatio : 0.7,
    volMaPeriod:
      typeof pivot.volMaPeriod === "number" ? pivot.volMaPeriod : 20,
    cooldown: typeof pivot.cooldown === "number" ? pivot.cooldown : 5,
    atrPeriod: typeof pivot.atrPeriod === "number" ? pivot.atrPeriod : 14,
    // 失效标记（缺字段回落默认，兼容旧 localStorage）
    markInvalidated: pivot.markInvalidated !== false,
    invalidateAtrMult:
      typeof pivot.invalidateAtrMult === "number" ? pivot.invalidateAtrMult : 0,
  }
}

/** 附着或更新 V2 markers 插件；关闭时清空 */
export function applyPivotV2Markers(
  series: ISeriesApi<"Candlestick"> | null,
  pluginRef: { current: ISeriesMarkersPluginApi<Time> | null },
  bars: KlineBar[],
  period: KlinePeriod,
  pivot: PivotV2Config,
): void {
  if (!series || period === "tick" || !pivot.enabled) {
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

  const signals = calcPivotSignalsV2(
    bars,
    Math.max(1, Math.floor(pivot.left)),
    Math.max(2, Math.floor(pivot.right)),
    optionsFromPivotV2(pivot),
  )
  // hideInvalidated：假信号直接不进 markers（false = 灰显带 ✕）
  const visible =
    pivot.hideInvalidated === true
      ? signals.filter((s) => s.invalidated !== true)
      : signals
  const invalidatedColor =
    typeof pivot.invalidatedColor === "string" && pivot.invalidatedColor
      ? pivot.invalidatedColor
      : "#6b7280"
  const markers: SeriesMarker<Time>[] = visible.map((s) => {
    const time = formatChartTime(period, s.time)
    // 触发形态后缀：放=放量拒绝、缩=缩量失败（无量能数据则不带）
    const tag = s.pattern === "wick_expand" ? "放" : s.pattern === "attack_shrink" ? "缩" : ""
    // 假信号：灰色 +「✕」后缀（lightweight-charts 无删除线/透明度可用）
    const invalidated = s.invalidated === true
    const invSuffix = invalidated ? "✕" : ""
    if (s.side === "long") {
      return {
        time,
        position: "belowBar",
        shape: "arrowUp",
        color: invalidated ? invalidatedColor : pivot.longColor,
        text: `多${tag}${invSuffix}`,
        size: 1,
      }
    }
    return {
      time,
      position: "aboveBar",
      shape: "arrowDown",
      color: invalidated ? invalidatedColor : pivot.shortColor,
      text: `空${tag}${invSuffix}`,
      size: 1,
    }
  })
  try {
    pluginRef.current.setMarkers(markers)
  } catch {
    // 时间不一致等：忽略单次
  }
}
