"use client"

/**
 * 成交量分布 store —— 本地采集聚合态（当日，symbol 小写键）
 *
 * 数据由 volume-profile-engine 逐秒写入（WS orderbook/quote 快照采集，
 * 口径见 lib/volume-profile-core）；持久化同样由引擎负责（IndexedDB
 * 按交易日整包），本 store 只承载内存态与 React 订阅。
 */

import { create } from "zustand"

import type { VolumeProfileAcc } from "@/lib/volume-profile-core"

/** IndexedDB 持久化整包形状（key = 交易日 "YYYY-MM-DD"） */
export interface VolumeProfileDayBlob {
  key: string
  day: string
  bySymbol: Record<string, VolumeProfileAcc>
}

interface VolumeProfileState {
  /** 当前聚合归属交易日（跨日由引擎切换并清桶） */
  day: string
  /** symbol(小写) → 当日聚合态 */
  bySymbol: Record<string, VolumeProfileAcc>
  /** 启动恢复是否完成（IDB 不可用时也置 true，走纯内存降级） */
  restored: boolean
  /** 引擎心跳批量提交本秒采集结果 */
  applyTicks: (updates: Record<string, VolumeProfileAcc>) => void
  /** 启动恢复（IDB 读回） */
  restore: (day: string, bySymbol: Record<string, VolumeProfileAcc>) => void
  /** 跨日清桶 */
  resetDay: (day: string) => void
}

export const useVolumeProfileStore = create<VolumeProfileState>((set) => ({
  day: "",
  bySymbol: {},
  restored: false,
  applyTicks: (updates) => {
    set((state) => {
      // 心跳内各品种聚合相互独立：浅合并顶层即可（值本身不可变）
      return { bySymbol: { ...state.bySymbol, ...updates } }
    })
  },
  restore: (day, bySymbol) => set({ day, bySymbol, restored: true }),
  resetDay: (day) => set({ day, bySymbol: {}, restored: true }),
}))
