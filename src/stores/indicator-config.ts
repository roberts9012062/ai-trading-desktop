"use client"

/**
 * 指标配置 store 共享工厂
 * 4 份指标 store（行情页全局 / 分屏 2-4 / 回测 / AI 看盘）的归一化与全部
 * action 唯一实现，差异只有 STORAGE_KEY 与持久化策略两点；新增指标字段 /
 * action 只改这一处（此前 4 份重复，漏加任一份会被静默丢弃）。
 */

// 归一化与 localStorage 读写拆至 indicator-config-io.ts（本文件加 V2 字段
// 与 action 后守住 300 行上限）；re-export 保持既有导入路径不变
export {
  loadIndicatorConfig,
  normalizeIndicatorConfig,
  saveIndicatorConfig,
} from "./indicator-config-io"
import { normalizeIndicatorConfig } from "./indicator-config-io"
import type { LocalIndicatorState } from "./indicator-config-io"
export type { LocalIndicatorState } from "./indicator-config-io"

import {
  DEFAULT_INDICATOR_CONFIG,
  PRESET_COLORS,
  type BOLLConfig,
  type IndicatorConfig,
  type JDKConfig,
  type MALineConfig,
  type MACDConfig,
  type PivotSignalConfig,
  type PivotV2Config,
  type PivotVersion,
  type RSIConfig,
  type StrengthConfig,
  type StrengthV2Config,
  type StrengthVersion,
} from "@/types/indicator"

/** 各 store 的全部指标 action（config 之外的状态由各 store 自行扩展） */
export interface IndicatorActions {
  setConfig: (updater: (prev: IndicatorConfig) => IndicatorConfig) => void
  /** Agent / 外部整包应用指标配置 */
  applyConfig: (config: IndicatorConfig | Record<string, unknown>) => void
  addMALine: () => void
  removeMALine: (index: number) => void
  updateMALine: (index: number, patch: Partial<MALineConfig>) => void
  updateMACD: (patch: Partial<MACDConfig>) => void
  toggleMACD: () => void
  updateRSI: (patch: Partial<RSIConfig>) => void
  toggleRSI: () => void
  updateBOLL: (patch: Partial<BOLLConfig>) => void
  toggleBOLL: () => void
  updateJDK: (patch: Partial<JDKConfig>) => void
  toggleJDK: () => void
  updateStrength: (patch: Partial<StrengthConfig>) => void
  toggleStrength: () => void
  updateStrengthV2: (patch: Partial<StrengthV2Config>) => void
  toggleStrengthV2: () => void
  /** 强弱版本二选一（V1 / V2 同一时刻只生效一个） */
  setStrengthVersion: (version: StrengthVersion) => void
  updatePivot: (patch: Partial<PivotSignalConfig>) => void
  togglePivot: () => void
  updatePivotV2: (patch: Partial<PivotV2Config>) => void
  togglePivotV2: () => void
  /** 波段版本二选一（V1 / V2 同一时刻只生效一个） */
  setPivotVersion: (version: PivotVersion) => void
  resetToDefault: () => void
}

/** 工厂所需的 zustand set 形状：接受「读 config、回写 config」的更新函数 */
export type IndicatorSetFn = (
  updater: (state: { config: IndicatorConfig }) => { config: IndicatorConfig },
) => void

/** 生成全套指标 action；persist 策略由调用方注入（仅 localStorage 的 store 传
 * saveIndicatorConfig 包装，行情页全局 store 传「localStorage + 防抖后端」实现） */
export function createIndicatorActions(
  set: IndicatorSetFn,
  persist: (next: IndicatorConfig) => void,
): IndicatorActions {
  /** 更新整个 config 并持久化（各 action 的公共收尾） */
  const commit = (
    state: { config: IndicatorConfig },
    next: IndicatorConfig,
  ): { config: IndicatorConfig } => {
    persist(next)
    return { config: next }
  }

  return {
    setConfig: (updater) =>
      set((state) => commit(state, updater(state.config))),

    applyConfig: (config) => {
      const next = normalizeIndicatorConfig(config as Partial<IndicatorConfig>)
      persist(next)
      set(() => ({ config: next }))
    },

    addMALine: () =>
      set((state) => {
        if (state.config.maLines.length >= 5) return state
        const usedColors = new Set(state.config.maLines.map((l) => l.color))
        const color =
          PRESET_COLORS.find((c) => !usedColors.has(c)) ?? PRESET_COLORS[0]
        return commit(state, {
          ...state.config,
          maLines: [...state.config.maLines, { period: 60, color }],
        })
      }),

    removeMALine: (index) =>
      set((state) =>
        commit(state, {
          ...state.config,
          maLines: state.config.maLines.filter((_, i) => i !== index),
        }),
      ),

    updateMALine: (index, patch) =>
      set((state) =>
        commit(state, {
          ...state.config,
          maLines: state.config.maLines.map((line, i) =>
            i === index ? { ...line, ...patch } : line
          ),
        }),
      ),

    updateMACD: (patch) =>
      set((state) =>
        commit(state, {
          ...state.config,
          macd: { ...state.config.macd, ...patch },
        }),
      ),

    toggleMACD: () =>
      set((state) =>
        commit(state, {
          ...state.config,
          macd: {
            ...state.config.macd,
            enabled: !state.config.macd.enabled,
          },
        }),
      ),
    updateRSI: (patch) =>
      set((state) =>
        commit(state, {
          ...state.config,
          rsi: { ...state.config.rsi, ...patch },
        }),
      ),

    toggleRSI: () =>
      set((state) =>
        commit(state, {
          ...state.config,
          rsi: { ...state.config.rsi, enabled: !state.config.rsi.enabled },
        }),
      ),
    updateBOLL: (patch) =>
      set((state) =>
        commit(state, {
          ...state.config,
          boll: { ...state.config.boll, ...patch },
        }),
      ),

    toggleBOLL: () =>
      set((state) =>
        commit(state, {
          ...state.config,
          boll: { ...state.config.boll, enabled: !state.config.boll.enabled },
        }),
      ),
    updateJDK: (patch) =>
      set((state) =>
        commit(state, {
          ...state.config,
          jdk: { ...state.config.jdk, ...patch },
        }),
      ),

    toggleJDK: () =>
      set((state) =>
        commit(state, {
          ...state.config,
          jdk: { ...state.config.jdk, enabled: !state.config.jdk.enabled },
        }),
      ),
    updateStrength: (patch) =>
      set((state) =>
        commit(state, {
          ...state.config,
          strength: { ...state.config.strength, ...patch },
        }),
      ),

    toggleStrength: () =>
      set((state) =>
        commit(state, {
          ...state.config,
          strength: {
            ...state.config.strength,
            enabled: !state.config.strength.enabled,
          },
        }),
      ),
    updateStrengthV2: (patch) =>
      set((state) =>
        commit(state, {
          ...state.config,
          strengthV2: { ...state.config.strengthV2, ...patch },
        }),
      ),

    toggleStrengthV2: () =>
      set((state) =>
        commit(state, {
          ...state.config,
          strengthV2: {
            ...state.config.strengthV2,
            enabled: !state.config.strengthV2.enabled,
          },
        }),
      ),

    setStrengthVersion: (version) =>
      set((state) =>
        commit(state, { ...state.config, strengthVersion: version }),
      ),

    updatePivot: (patch) =>
      set((state) => {
        const base = state.config.pivot ?? DEFAULT_INDICATOR_CONFIG.pivot
        return commit(state, {
          ...state.config,
          pivot: { ...base, ...patch },
        })
      }),

    togglePivot: () =>
      set((state) => {
        const base = state.config.pivot ?? DEFAULT_INDICATOR_CONFIG.pivot
        return commit(state, {
          ...state.config,
          pivot: { ...base, enabled: !base.enabled },
        })
      }),

    updatePivotV2: (patch) =>
      set((state) => {
        const base = state.config.pivotV2 ?? DEFAULT_INDICATOR_CONFIG.pivotV2
        return commit(state, {
          ...state.config,
          pivotV2: { ...base, ...patch },
        })
      }),

    togglePivotV2: () =>
      set((state) => {
        const base = state.config.pivotV2 ?? DEFAULT_INDICATOR_CONFIG.pivotV2
        return commit(state, {
          ...state.config,
          pivotV2: { ...base, enabled: !base.enabled },
        })
      }),

    setPivotVersion: (version) =>
      set((state) =>
        commit(state, { ...state.config, pivotVersion: version }),
      ),

    resetToDefault: () => {
      persist(DEFAULT_INDICATOR_CONFIG)
      set(() => ({ config: DEFAULT_INDICATOR_CONFIG }))
    },
  }
}
