/**
 * 副图指标注册表
 *
 * 新增一个副图指标 = 新增一个注册项文件（照抄 macd.ts 结构）并登记到
 * SUB_INDICATORS 数组；框架（use-chart-series / use-realtime-kline /
 * 回测 use-indicator-series）只遍历注册表，不再逐指标写分支。
 * 注册表数组顺序 = 副图自上而下的排列顺序。
 */

import type {
  IChartApi,
  ISeriesApi,
  ISeriesMarkersPluginApi,
  SeriesType,
  Time,
} from "lightweight-charts"
import type { IndicatorConfig } from "@/types/indicator"
import type { KlineBar, KlinePeriod } from "@/types"
import { MACD_DEF } from "./macd"
import { RSI_DEF } from "./rsi"
import { JDK_DEF } from "./jdk"
import { STRENGTH_DEF } from "./strength"
import { STRENGTH_V2_DEF } from "./strength-v2"
import { applyPaneLayout } from "./pane-sizing"

/** 副图指标 id —— 同时是 IndicatorConfig 里对应配置块的 key */
export type SubIndicatorId = "macd" | "rsi" | "jdk" | "strength" | "strengthV2"

/** 一个副图指标创建出的全部图元，统一由框架清理 */
export interface SubIndicatorHandle {
  /** 本指标创建的所有 series（框架负责 removeSeries） */
  series: ISeriesApi<SeriesType>[]
  /** markers 插件（强弱指标的进场箭头用；无则 null） */
  markers: ISeriesMarkersPluginApi<Time> | null
  paneIndex: number
}

/** 副图指标注册项 —— 各指标在此闭包内读取自己那块配置 */
export interface SubIndicatorDef {
  /** 唯一 id，同时是 IndicatorConfig 的 key */
  id: SubIndicatorId
  /** 「指标」按钮上的提示文案 */
  label: string
  /** 是否启用（读 IndicatorConfig 对应块） */
  isEnabled: (cfg: IndicatorConfig) => boolean
  /** 在指定 pane 创建 series */
  createSeries: (
    chart: IChartApi,
    cfg: IndicatorConfig,
    paneIndex: number,
  ) => SubIndicatorHandle
  /** 全量写入 */
  setData: (
    h: SubIndicatorHandle,
    bars: KlineBar[],
    period: KlinePeriod,
    cfg: IndicatorConfig,
  ) => void
  /** 实时更新末根（不做全量重算） */
  updateLast: (
    h: SubIndicatorHandle,
    bars: KlineBar[],
    period: KlinePeriod,
    cfg: IndicatorConfig,
  ) => void
}

/** 注册表 —— 数组顺序 = 副图自上而下的顺序 */
export const SUB_INDICATORS: readonly SubIndicatorDef[] = [
  MACD_DEF,
  RSI_DEF,
  JDK_DEF,
  STRENGTH_DEF,
  STRENGTH_V2_DEF,
]

/** 当前配置下启用的副图注册项（保持注册表顺序） */
export function enabledSubIndicators(
  cfg: IndicatorConfig,
): readonly SubIndicatorDef[] {
  return SUB_INDICATORS.filter((d) => d.isEnabled(cfg))
}

/**
 * 为每个启用的副图指标开独立 pane 并创建 series，写入 handles。
 * 返回本轮启用的注册项（调用方可直接用于后续 setData）。
 * 须在主图 series 创建完成后调用；pane 顺序 = 注册表顺序。
 */
export function createSubIndicatorPanes(
  chart: IChartApi,
  cfg: IndicatorConfig,
  handles: Map<SubIndicatorId, SubIndicatorHandle>,
): readonly SubIndicatorDef[] {
  const defs = enabledSubIndicators(cfg)
  for (const def of defs) {
    const pane = chart.addPane()
    handles.set(def.id, def.createSeries(chart, cfg, pane.paneIndex()))
  }
  applyPaneLayout(chart, defs.map((d) => d.id))
  return defs
}

/** 全量写入所有副图（未启用/无 handle 的自动跳过） */
export function writeSubIndicatorsData(
  handles: Map<SubIndicatorId, SubIndicatorHandle>,
  bars: KlineBar[],
  period: KlinePeriod,
  cfg: IndicatorConfig,
): void {
  for (const def of enabledSubIndicators(cfg)) {
    const h = handles.get(def.id)
    if (h) def.setData(h, bars, period, cfg)
  }
}

/** 实时增量更新所有副图末点（未启用/无 handle 的自动跳过） */
export function updateSubIndicatorsLast(
  handles: Map<SubIndicatorId, SubIndicatorHandle>,
  bars: KlineBar[],
  period: KlinePeriod,
  cfg: IndicatorConfig,
): void {
  for (const def of enabledSubIndicators(cfg)) {
    const h = handles.get(def.id)
    if (h) def.updateLast(h, bars, period, cfg)
  }
}

/** 清空所有副图 series 数据（切到无数据合约时清残影用） */
export function clearSubIndicators(
  handles: Map<SubIndicatorId, SubIndicatorHandle>,
): void {
  for (const h of handles.values()) {
    for (const s of h.series) {
      try {
        s.setData([])
      } catch {
        /* series 可能已销毁 */
      }
    }
  }
}

/** 从 chart 上移除所有副图 series（series 清空后空 pane 自动回收） */
export function removeSubIndicatorSeries(
  chart: IChartApi,
  handles: Map<SubIndicatorId, SubIndicatorHandle>,
): void {
  for (const h of handles.values()) {
    for (const s of h.series) {
      try {
        chart.removeSeries(s)
      } catch {
        /* series 可能已销毁 */
      }
    }
  }
}
