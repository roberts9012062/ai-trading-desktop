"use client"

/**
 * 回测专用指标配置 store
 *
 * 与实时行情的 useIndicatorStore 完全隔离：独立的 localStorage key、
 * 不写后端（回测指标无需跨设备同步）。开关/参数/颜色全部独立。
 * 这样在 AI K 线页开启 BOLL 不影响行情页，反之亦然。
 * 归一化与全部 action 来自共享工厂 stores/indicator-config.ts。
 */

import { create } from "zustand"
import {
  createIndicatorActions,
  loadIndicatorConfig,
  saveIndicatorConfig,
  type LocalIndicatorState,
} from "@/stores/indicator-config"

const STORAGE_KEY = "qihuo-backtest-indicators"

export type BacktestIndicatorState = LocalIndicatorState

/** 回测专用指标 store —— 仅 localStorage，不写后端，与行情 store 隔离 */
export const useBacktestIndicatorStore = create<BacktestIndicatorState>(
  (set) => ({
    config: loadIndicatorConfig(STORAGE_KEY),
    ...createIndicatorActions(
      set,
      (next) => saveIndicatorConfig(STORAGE_KEY, next),
    ),
  }),
)
