"use client"

import { create } from "zustand"
import {
  DEFAULT_INDICATOR_CONFIG,
  type IndicatorConfig,
} from "@/types/indicator"
import { useAuthStore } from "@/stores/auth"
import { getIndicatorSettingsApi, saveIndicatorSettingsApi } from "@/lib/api"
import {
  createIndicatorActions,
  loadIndicatorConfig,
  normalizeIndicatorConfig,
  saveIndicatorConfig,
  type IndicatorActions,
} from "@/stores/indicator-config"

const STORAGE_KEY = "qihuo-indicators"
/** 后端保存防抖（合并高频调参） */
const SAVE_DEBOUNCE_MS = 800

/** 配置粗略相等比较（结构化字段顺序一致） */
function configEquals(a: IndicatorConfig, b: IndicatorConfig): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/** 后端保存防抖句柄（模块级，跨 set 共享） */
let saveTimer: ReturnType<typeof setTimeout> | null = null

export interface IndicatorState extends IndicatorActions {
  config: IndicatorConfig
  /** 是否已从后端加载（避免重复拉取） */
  loaded: boolean
  /** 登录后从后端加载（含老用户 localStorage 迁移） */
  loadFromServer: () => Promise<void>
}

/** 指标配置 store —— 后端为权威源，localStorage 作缓存 */
export const useIndicatorStore = create<IndicatorState>((set, get) => {
  /** 持久化：即时写 localStorage 缓存，登录态下防抖存后端 */
  function persist(next: IndicatorConfig): void {
    saveIndicatorConfig(STORAGE_KEY, next)
    if (typeof window === "undefined") return
    if (!useAuthStore.getState().accessToken) return
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      void saveIndicatorSettingsApi(next).catch(() => {
        // 保存失败静默：localStorage 已缓存，下次改动会重试
      })
    }, SAVE_DEBOUNCE_MS)
  }

  return {
    // 归一化与全套 update*/toggle* action 来自共享工厂（stores/indicator-config.ts）
    ...createIndicatorActions(set, persist),

    config: loadIndicatorConfig(STORAGE_KEY),
    loaded: false,

    // loadFromServer 是存量用户唯一的配置继承路径，逻辑保持原样
    loadFromServer: async () => {
      if (get().loaded) return
      if (typeof window === "undefined") return
      if (!useAuthStore.getState().accessToken) return
      try {
        const serverRaw = await getIndicatorSettingsApi()
        const serverConfig = normalizeIndicatorConfig(serverRaw)
        // 老用户迁移：后端无记录(=默认) 且 localStorage 有非默认值 → 上传本地
        const localRaw = localStorage.getItem(STORAGE_KEY)
        const localConfig = localRaw
          ? normalizeIndicatorConfig(JSON.parse(localRaw) as Partial<IndicatorConfig>)
          : null
        const serverIsDefault = configEquals(serverConfig, DEFAULT_INDICATOR_CONFIG)
        if (
          serverIsDefault &&
          localConfig &&
          !configEquals(localConfig, DEFAULT_INDICATOR_CONFIG)
        ) {
          // 后端空、本地有自定义 → 以本地为准并上传
          void saveIndicatorSettingsApi(localConfig).catch(() => {})
          set({ config: localConfig, loaded: true })
          return
        }
        // 后端有记录或本地也是默认 → 用后端
        saveIndicatorConfig(STORAGE_KEY, serverConfig)
        set({ config: serverConfig, loaded: true })
      } catch {
        // 未登录 / 网络失败：保持 localStorage，不标 loaded 以便下次重试
      }
    },
  }
})
