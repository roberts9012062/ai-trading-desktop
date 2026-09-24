"use client"

/**
 * 行情页分屏 K 线专用指标 store
 *
 * 行情页 K 线支持 2/3/4 分屏后，每个分屏的指标设置必须互相隔离、互不干扰：
 * - 分屏 1 沿用全局 useIndicatorStore（保留服务端同步的既有行为）；
 * - 分屏 2/3/4 使用本工厂创建的独立 store：仅 localStorage、不写后端，
 *   与主屏 / AI 看盘 / 回测互不影响（同 ai-market-indicator 的隔离模式）。
 * 在分屏 2 开 BOLL 不影响分屏 1/3/4，反之亦然。
 * 归一化与全部 action 来自共享工厂 stores/indicator-config.ts。
 */

import { create, type StoreApi, type UseBoundStore } from "zustand"
import {
  createIndicatorActions,
  loadIndicatorConfig,
  saveIndicatorConfig,
  type LocalIndicatorState,
} from "@/stores/indicator-config"

/** 创建一个仅 localStorage 持久化的分屏指标 store */
function createPaneIndicatorStore(
  storageKey: string,
): UseBoundStore<StoreApi<LocalIndicatorState>> {
  return create<LocalIndicatorState>((set) => ({
    config: loadIndicatorConfig(storageKey),
    ...createIndicatorActions(
      set,
      (next) => saveIndicatorConfig(storageKey, next),
    ),
  }))
}

/** 分屏 2 指标 store —— 与主屏/其他分屏完全隔离 */
export const useMarketPane2IndicatorStore = createPaneIndicatorStore(
  "qihuo-market-pane2-indicators",
)

/** 分屏 3 指标 store —— 与主屏/其他分屏完全隔离 */
export const useMarketPane3IndicatorStore = createPaneIndicatorStore(
  "qihuo-market-pane3-indicators",
)

/** 分屏 4 指标 store —— 与主屏/其他分屏完全隔离 */
export const useMarketPane4IndicatorStore = createPaneIndicatorStore(
  "qihuo-market-pane4-indicators",
)
