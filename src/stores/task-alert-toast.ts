/**
 * 任务预警弹窗状态 —— transient 队列（不入库）
 *
 * 承载任务下单/平仓命中预警的瞬时提醒，支持多条堆叠，单条 10s 自动消失。
 */

import { create } from "zustand"

export interface TaskAlertToast {
  id: number
  taskId: string
  symbol: string
  direction: "buy" | "sell"
  offset: "open" | "close"
  price: number | null
  qty: number
  /** 红/绿/橙 由 direction+offset 决定：开多红、开空绿、平仓橙 */
  color: string
  /** 创建时间戳 */
  ts: number
}

interface TaskAlertToastState {
  toasts: TaskAlertToast[]
  push: (t: Omit<TaskAlertToast, "id" | "ts">) => void
  dismiss: (id: number) => void
}

const MAX_TOASTS = 5

let _seq = 0

export const useTaskAlertToastStore = create<TaskAlertToastState>((set) => ({
  toasts: [],

  push: (t) => {
    _seq += 1
    const id = _seq
    const toast: TaskAlertToast = { ...t, id, ts: Date.now() }
    set((state) => {
      const next = [...state.toasts, toast]
      if (next.length > MAX_TOASTS) {
        next.splice(0, next.length - MAX_TOASTS)
      }
      return { toasts: next }
    })
  },

  dismiss: (id) =>
    set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) })),
}))
