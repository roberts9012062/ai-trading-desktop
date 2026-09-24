"use client"

/**
 * AI 看盘行情专用指标配置 store
 *
 * 与行情页 useIndicatorStore 完全隔离：独立的 localStorage key、
 * 不写后端（AI 看盘为行情衍生页，指标偏好独立保存即可）。
 * 开关/参数/颜色全部独立：在 AI 看盘页开启 BOLL 不影响行情页，反之亦然。
 * 归一化与全部 action 来自共享工厂 stores/indicator-config.ts。
 */

import { create } from "zustand"
import {
  createIndicatorActions,
  loadIndicatorConfig,
  saveIndicatorConfig,
  type LocalIndicatorState,
} from "@/stores/indicator-config"

const STORAGE_KEY = "qihuo-ai-market-indicators"

export type AiMarketIndicatorState = LocalIndicatorState

/** AI 看盘专用指标 store —— 仅 localStorage，不写后端，与行情/回测 store 隔离 */
export const useAiMarketIndicatorStore = create<AiMarketIndicatorState>(
  (set) => ({
    config: loadIndicatorConfig(STORAGE_KEY),
    ...createIndicatorActions(
      set,
      (next) => saveIndicatorConfig(STORAGE_KEY, next),
    ),
  }),
)
