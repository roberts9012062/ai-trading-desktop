"use client"

/**
 * 任务预警设置 store（AI 看盘行情 / 任务下单·平仓提醒）
 *
 * 模式镜像 big-order store：localStorage 即时缓存 + 后端防抖同步。
 * 事件经 WS task_order_tick 抵达（仅本人任务，服务端按 user_id 定向），
 * 本 store 只承载设置与开关判定。
 */

import { create } from "zustand"
import { useAuthStore } from "@/stores/auth"
import {
  getTaskAlertSettingsApi,
  saveTaskAlertSettingsApi,
  type TaskAlertSettings,
} from "@/lib/ai-trading-api"

const STORAGE_KEY = "qihuo-task-alert-settings"
const SAVE_DEBOUNCE_MS = 800

export const DEFAULT_TASK_ALERT_SETTINGS: TaskAlertSettings = {
  open_enabled: true,
  close_enabled: true,
  popup_enabled: true,
  sound_enabled: true,
  voice_enabled: false,
}

function normalize(raw: Partial<TaskAlertSettings> | null): TaskAlertSettings {
  if (!raw) return { ...DEFAULT_TASK_ALERT_SETTINGS }
  return { ...DEFAULT_TASK_ALERT_SETTINGS, ...raw }
}

function loadLocal(): TaskAlertSettings {
  if (typeof window === "undefined") return { ...DEFAULT_TASK_ALERT_SETTINGS }
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...DEFAULT_TASK_ALERT_SETTINGS }
    return normalize(JSON.parse(raw) as Partial<TaskAlertSettings>)
  } catch {
    return { ...DEFAULT_TASK_ALERT_SETTINGS }
  }
}

function saveLocal(s: TaskAlertSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s))
  } catch {
    // 静默
  }
}

let saveTimer: ReturnType<typeof setTimeout> | null = null

interface TaskAlertState {
  settings: TaskAlertSettings
  loaded: boolean
  /** 更新部分设置字段（即时写本地 + 防抖写后端） */
  updateSettings: (patch: Partial<TaskAlertSettings>) => void
  /** 登录后从后端加载 */
  loadFromServer: () => Promise<void>
}

export const useTaskAlertStore = create<TaskAlertState>((set, get) => {
  function persist(next: TaskAlertSettings): void {
    saveLocal(next)
    if (typeof window === "undefined") return
    if (!useAuthStore.getState().accessToken) return
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      void saveTaskAlertSettingsApi(next).catch(() => {})
    }, SAVE_DEBOUNCE_MS)
  }

  return {
    settings: loadLocal(),
    loaded: false,

    updateSettings: (patch) =>
      set((state) => {
        const next = { ...state.settings, ...patch }
        persist(next)
        return { settings: next }
      }),

    loadFromServer: async () => {
      if (get().loaded) return
      if (typeof window === "undefined") return
      if (!useAuthStore.getState().accessToken) return
      try {
        const server = await getTaskAlertSettingsApi()
        const merged = normalize(server)
        saveLocal(merged)
        set({ settings: merged, loaded: true })
      } catch {
        // 未登录 / 网络失败：保持 localStorage
      }
    },
  }
})

/**
 * 判定一条任务成交流水是否命中用户预警开关。
 * offset=open → 开仓预警；offset=close → 平仓预警。
 */
export function isTaskAlertHit(
  offset: string,
  settings: TaskAlertSettings,
): boolean {
  if (offset === "close") return settings.close_enabled
  if (offset === "open") return settings.open_enabled
  return false
}
