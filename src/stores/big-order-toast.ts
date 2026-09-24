/**
 * 大单预警弹窗状态 —— transient 队列（不入库）
 *
 * 与 notifications store 区分：这里只承载大单命中的瞬时提醒，
 * 不写后端 Notification 表。支持多条堆叠，单条 10s 自动消失。
 */

import { create } from "zustand"

export interface BigOrderToast {
  id: number
  symbol: string
  direction: "buy" | "sell"
  volume: number
  price: number | null
  color: string
  /** 创建时间戳（用于去重/限频） */
  ts: number
}

interface BigOrderToastState {
  /** 当前显示的大单提醒队列（最多 5 条） */
  toasts: BigOrderToast[]
  /** 推入一条（超出的旧条目滚动丢弃） */
  push: (t: Omit<BigOrderToast, "id" | "ts">) => void
  /** 移除指定 id */
  dismiss: (id: number) => void
}

const MAX_TOASTS = 5

let _seq = 0

export const useBigOrderToastStore = create<BigOrderToastState>((set) => ({
  toasts: [],

  push: (t) => {
    _seq += 1
    const id = _seq
    const toast: BigOrderToast = { ...t, id, ts: Date.now() }
    set((state) => {
      const next = [...state.toasts, toast]
      // 超出上限丢弃最旧
      if (next.length > MAX_TOASTS) {
        next.splice(0, next.length - MAX_TOASTS)
      }
      return { toasts: next }
    })
  },

  dismiss: (id) =>
    set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) })),
}))
