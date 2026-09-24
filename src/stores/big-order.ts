"use client"

import { create } from "zustand"
import { useAuthStore } from "@/stores/auth"
import {
  getBigOrderSettingsApi,
  saveBigOrderSettingsApi,
} from "@/lib/api"
// 纯逻辑从 .mjs 导入（单一真相源，供 node:test 覆盖）
import {
  DEFAULT_BIG_ORDER_SETTINGS as DEFAULTS,
  isBigOrderHit as _isBigOrderHit,
  bigOrderColor as _bigOrderColor,
  bigOrderThreshold as _bigOrderThreshold,
  passesFilter as _passesFilter,
  isFilterActive as _isFilterActive,
} from "@/components/market/big-order-data.mjs"

/**
 * 大单预警设置 store
 *
 * 模式参考 indicator store：localStorage 即时缓存 + 后端防抖同步。
 * 设置含多空阈值/颜色与弹窗/提示音/语音开关，由成交面板与预警弹窗消费。
 */

const STORAGE_KEY = "qihuo-big-order-settings"
const SAVE_DEBOUNCE_MS = 800

export type BigOrderSettings = {
  buy_enabled: boolean
  buy_threshold: number
  buy_color: string
  sell_enabled: boolean
  sell_threshold: number
  sell_color: string
  popup_enabled: boolean
  sound_enabled: boolean
  voice_enabled: boolean
}

export const DEFAULT_BIG_ORDER_SETTINGS: BigOrderSettings = {
  ...DEFAULTS,
} as BigOrderSettings

/** 多空方向 → 对应的字段族 */
export type BigOrderDirection = "buy" | "sell"

export type BigOrderFilter = {
  /** 成交列表筛选：全部 / 多单 / 空单 */
  direction: "all" | BigOrderDirection
  /** 最小手数筛选（0 表示不限） */
  minVolume: number
}

export const DEFAULT_FILTER: BigOrderFilter = { direction: "all", minVolume: 0 }

/** 合并默认配置，兼容旧 localStorage 缺字段 */
function normalize(raw: Partial<BigOrderSettings> | null): BigOrderSettings {
  if (!raw) return { ...DEFAULT_BIG_ORDER_SETTINGS }
  return { ...DEFAULT_BIG_ORDER_SETTINGS, ...raw }
}

function loadLocal(): BigOrderSettings {
  if (typeof window === "undefined") return { ...DEFAULT_BIG_ORDER_SETTINGS }
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...DEFAULT_BIG_ORDER_SETTINGS }
    return normalize(JSON.parse(raw) as Partial<BigOrderSettings>)
  } catch {
    return { ...DEFAULT_BIG_ORDER_SETTINGS }
  }
}

function saveLocal(s: BigOrderSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s))
  } catch {
    // 静默
  }
}

let saveTimer: ReturnType<typeof setTimeout> | null = null

interface BigOrderState {
  settings: BigOrderSettings
  filter: BigOrderFilter
  loaded: boolean
  /** 更新部分设置字段（即时写本地 + 防抖写后端） */
  updateSettings: (patch: Partial<BigOrderSettings>) => void
  /** 切换多/空单启用 */
  toggleDirection: (dir: BigOrderDirection) => void
  /** 更新筛选条件（仅前端，不入库） */
  setFilter: (patch: Partial<BigOrderFilter>) => void
  /** 登录后从后端加载 */
  loadFromServer: () => Promise<void>
}

export const useBigOrderStore = create<BigOrderState>((set, get) => {
  function persist(next: BigOrderSettings): void {
    saveLocal(next)
    if (typeof window === "undefined") return
    if (!useAuthStore.getState().accessToken) return
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      void saveBigOrderSettingsApi(next).catch(() => {})
    }, SAVE_DEBOUNCE_MS)
  }

  return {
    settings: loadLocal(),
    filter: { ...DEFAULT_FILTER },
    loaded: false,

    updateSettings: (patch) =>
      set((state) => {
        const next = { ...state.settings, ...patch }
        persist(next)
        return { settings: next }
      }),

    toggleDirection: (dir) =>
      set((state) => {
        const key = dir === "buy" ? "buy_enabled" : "sell_enabled"
        const next = { ...state.settings, [key]: !state.settings[key] }
        persist(next)
        return { settings: next }
      }),

    setFilter: (patch) =>
      set((state) => ({ filter: { ...state.filter, ...patch } })),

    loadFromServer: async () => {
      if (get().loaded) return
      if (typeof window === "undefined") return
      if (!useAuthStore.getState().accessToken) return
      try {
        const server = await getBigOrderSettingsApi()
        const merged = { ...DEFAULT_BIG_ORDER_SETTINGS, ...server }
        saveLocal(merged)
        set({ settings: merged, loaded: true })
      } catch {
        // 未登录 / 网络失败：保持 localStorage
      }
    },
  }
})

/**
 * 判定单笔成交是否命中用户大单阈值。
 * 用于成交列表高亮（阶段 D）与 big_order_tick 预警入库（阶段 E）。
 */
export function isBigOrderHit(
  direction: BigOrderDirection,
  volume: number,
  settings: BigOrderSettings,
): boolean {
  return _isBigOrderHit(direction, volume, settings)
}

/** 取某方向的高亮色 */
export function bigOrderColor(
  direction: BigOrderDirection,
  settings: BigOrderSettings,
): string {
  return _bigOrderColor(direction, settings)
}

/** 取某方向的阈值 */
export function bigOrderThreshold(
  direction: BigOrderDirection,
  settings: BigOrderSettings,
): number {
  return _bigOrderThreshold(direction, settings)
}

/** 成交行是否通过当前筛选（前端纯逻辑，供组件复用） */
export function passesFilter(
  tradeDirection: "buy" | "sell",
  tradeVolume: number,
  filter: BigOrderFilter,
): boolean {
  return _passesFilter(tradeDirection, tradeVolume, filter)
}

/** 当前筛选是否激活 */
export function isFilterActive(filter: BigOrderFilter): boolean {
  return _isFilterActive(filter)
}

