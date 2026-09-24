"use client"

/**
 * 指标配置的归一化与 localStorage 读写
 *
 * 自 stores/indicator-config.ts 拆出（该文件加 V2 字段与 action 后守住
 * 300 行上限），indicator-config.ts re-export 保持既有导入路径不变；
 * 4 份指标 store（行情页全局 / 分屏 2-4 / 回测 / AI 看盘）共用本模块。
 */

import {
  DEFAULT_INDICATOR_CONFIG,
  PRESET_COLORS,
  type IndicatorConfig,
} from "@/types/indicator"
import type { IndicatorActions } from "./indicator-config"

/** 归一化：唯一实现，4 份 store 共用（合并默认配置，兼容旧 localStorage） */
export function normalizeIndicatorConfig(
  raw: Partial<IndicatorConfig> | null,
): IndicatorConfig {
  if (!raw || !Array.isArray(raw.maLines) || !raw.macd) {
    return DEFAULT_INDICATOR_CONFIG
  }
  return {
    maLines: raw.maLines.map((line) => ({
      period: line.period,
      color: line.color || PRESET_COLORS[0],
    })),
    macd: { ...DEFAULT_INDICATOR_CONFIG.macd, ...raw.macd },
    rsi: { ...DEFAULT_INDICATOR_CONFIG.rsi, ...(raw.rsi ?? {}) },
    boll: { ...DEFAULT_INDICATOR_CONFIG.boll, ...(raw.boll ?? {}) },
    jdk: { ...DEFAULT_INDICATOR_CONFIG.jdk, ...(raw.jdk ?? {}) },
    strength: {
      ...DEFAULT_INDICATOR_CONFIG.strength,
      ...(raw.strength ?? {}),
    },
    strengthV2: {
      ...DEFAULT_INDICATOR_CONFIG.strengthV2,
      ...(raw.strengthV2 ?? {}),
    },
    strengthVersion: raw.strengthVersion === "v2" ? "v2" : "v1",
    pivot: {
      ...DEFAULT_INDICATOR_CONFIG.pivot,
      ...(raw.pivot ?? {}),
    },
    pivotV2: {
      ...DEFAULT_INDICATOR_CONFIG.pivotV2,
      ...(raw.pivotV2 ?? {}),
    },
    pivotVersion: raw.pivotVersion === "v2" ? "v2" : "v1",
  }
}

/** 仅 localStorage 持久化的 store 状态（分屏 2-4 / 回测 / AI 看盘共用） */
export interface LocalIndicatorState extends IndicatorActions {
  config: IndicatorConfig
}

/** 从 localStorage 加载配置（按各 store 自己的 key） */
export function loadIndicatorConfig(storageKey: string): IndicatorConfig {
  if (typeof window === "undefined") return DEFAULT_INDICATOR_CONFIG
  try {
    const raw = localStorage.getItem(storageKey)
    if (!raw) return DEFAULT_INDICATOR_CONFIG
    return normalizeIndicatorConfig(JSON.parse(raw) as Partial<IndicatorConfig>)
  } catch {
    return DEFAULT_INDICATOR_CONFIG
  }
}

/** 保存配置到 localStorage（首屏缓存 / 未登录 fallback） */
export function saveIndicatorConfig(
  storageKey: string,
  config: IndicatorConfig,
): void {
  try {
    localStorage.setItem(storageKey, JSON.stringify(config))
  } catch {
    // localStorage 不可用时静默忽略
  }
}
