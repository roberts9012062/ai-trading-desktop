"use client"

/**
 * 语音播报设置 store —— localStorage 持久化（本设备）
 *
 * 模式参考 big-order store 的"localStorage 即时缓存"；播报为纯客户端
 * 行为（Web Speech API + WS 实时行情），配置不做服务端同步。
 */

import { create } from "zustand"
import {
  DEFAULT_SETTINGS,
  MAX_ITEMS,
  clampRate,
  isValidInterval,
  sanitizeSettings,
} from "@/lib/voice-broadcast-core.mjs"

/** 单条播报品种配置 */
export interface VoiceBroadcastItem {
  code: string
  name: string
  intervalMin: number
  enabled: boolean
}

export interface VoiceBroadcastSettings {
  enabled: boolean
  items: VoiceBroadcastItem[]
  /** 云端音色 ID（""=自动云希；"local"=本地系统语音） */
  voiceId: string
  /** 语速 0.5~2.0（1=常速） */
  rate: number
}

const STORAGE_KEY = "qihuo.voice-broadcast.v1"

interface VoiceBroadcastState {
  settings: VoiceBroadcastSettings
  hydrated: boolean
  hydrate: () => void
  setEnabled: (enabled: boolean) => void
  addItem: (code: string, name: string, intervalMin: number) => boolean
  removeItem: (code: string) => void
  setIntervalMin: (code: string, intervalMin: number) => void
  setItemEnabled: (code: string, enabled: boolean) => void
  setVoiceId: (voiceId: string) => void
  setRate: (rate: number) => void
}

function persist(next: VoiceBroadcastSettings): void {
  if (typeof window === "undefined") return
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch {
    // 隐私模式等写入失败：静默（内存态仍生效）
  }
}

export const useVoiceBroadcastStore = create<VoiceBroadcastState>()((set, get) => ({
  settings: { ...DEFAULT_SETTINGS, items: [] },
  hydrated: false,

  hydrate: () => {
    if (get().hydrated) return
    let loaded: VoiceBroadcastSettings = sanitizeSettings(null) as VoiceBroadcastSettings
    if (typeof window !== "undefined") {
      try {
        const raw = localStorage.getItem(STORAGE_KEY)
        if (raw) loaded = sanitizeSettings(JSON.parse(raw)) as VoiceBroadcastSettings
      } catch {
        // 损坏配置回落默认
      }
    }
    set({ settings: loaded, hydrated: true })
  },

  setEnabled: (enabled) => {
    const next = { ...get().settings, enabled }
    persist(next)
    set({ settings: next })
  },

  addItem: (code, name, intervalMin) => {
    const cur = get().settings
    const c = String(code || "").trim().toUpperCase()
    if (!c || !isValidInterval(intervalMin)) return false
    if (cur.items.length >= MAX_ITEMS) return false
    if (cur.items.some((it) => it.code === c)) return false
    const next = {
      ...cur,
      items: [
        ...cur.items,
        {
          code: c,
          name: String(name || c).trim() || c,
          intervalMin: Number(intervalMin),
          enabled: true,
        },
      ],
    }
    persist(next)
    set({ settings: next })
    return true
  },

  removeItem: (code) => {
    const cur = get().settings
    const next = { ...cur, items: cur.items.filter((it) => it.code !== code) }
    persist(next)
    set({ settings: next })
  },

  setIntervalMin: (code, intervalMin) => {
    if (!isValidInterval(intervalMin)) return
    const cur = get().settings
    const next = {
      ...cur,
      items: cur.items.map((it) =>
        it.code === code ? { ...it, intervalMin: Number(intervalMin) } : it,
      ),
    }
    persist(next)
    set({ settings: next })
  },

  setItemEnabled: (code, enabled) => {
    const cur = get().settings
    const next = {
      ...cur,
      items: cur.items.map((it) => (it.code === code ? { ...it, enabled } : it)),
    }
    persist(next)
    set({ settings: next })
  },

  setVoiceId: (voiceId) => {
    const next = { ...get().settings, voiceId: String(voiceId || "").slice(0, 64) }
    persist(next)
    set({ settings: next })
  },

  setRate: (rate) => {
    const next = { ...get().settings, rate: clampRate(rate) }
    persist(next)
    set({ settings: next })
  },
}))
