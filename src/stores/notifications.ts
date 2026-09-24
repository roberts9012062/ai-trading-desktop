/**
 * 消息弹窗 / 未读数状态 —— Zustand store（未读数唯一数据源）
 *
 * - 维护未读数 unread（由 WS unread_count 推送或 HTTP 拉）
 * - 维护右下角弹窗 popup：WS 收到 notification 时 showPopup，10s 后自动 dismiss
 * - markRead 调后端标记单条已读并递减 unread
 * - markAllRead 调后端全部已读并归零 unread（消息中心页 / 顶栏共用）
 * - decrementUnread 单条标记已读 / 删除未读消息后递减 unread，保证顶栏红点同步
 *
 * 顶栏 Bell 红点、消息中心页、右下角弹窗均订阅本 store 的 unread，
 * 避免多数据源脱节（如"标记已读后红点不归零"）。
 */

import { create } from "zustand"
import type { Message } from "@/types"
import {
  getUnreadCountApi,
  markNotificationReadApi,
  markAllNotificationsReadApi,
} from "@/lib/api"

interface NotificationsState {
  /** 未读消息数 */
  unread: number
  /** 当前弹窗消息（null=不显示） */
  popup: Message | null

  /** 直接设置未读数（WS unread_count 推送时用） */
  setUnread: (n: number) => void
  /** 显示弹窗（WS notification 推送时用） */
  showPopup: (msg: Message) => void
  /** 关闭弹窗 */
  dismissPopup: () => void
  /**
   * 标记单条已读：
   * 1) 调后端 markNotificationReadApi
   * 2) unread 减 1（不低于 0）
   * 3) 若当前弹窗即此消息，关闭弹窗
   */
  markRead: (id: string) => Promise<void>
  /**
   * 全部已读：
   * 1) 调后端 markAllNotificationsReadApi
   * 2) unread 归 0
   * 由消息中心页 / 顶栏调用，确保各处红点立即一致。
   */
  markAllRead: () => Promise<void>
  /**
   * 递减未读数（仅当 wasUnread 为真时 -1，不低于 0）。
   * 用于消息中心页单条标记已读 / 删除未读消息后同步顶栏红点，
   * 这些场景页面已自行调后端，这里只做本地状态收敛，不重复请求。
   */
  decrementUnread: (wasUnread: boolean) => void
  /** 从后端拉取未读数（首次进入页面 / 兜底轮询时用） */
  fetchUnread: () => Promise<void>
  /** 重置全部状态（登出 / 切账号时用，避免上一账号红点残留） */
  reset: () => void
}

export const useNotificationsStore = create<NotificationsState>(
  (set, get) => ({
    unread: 0,
    popup: null,

    setUnread: (n) => set({ unread: Math.max(0, n) }),

    showPopup: (msg) => set({ popup: msg }),

    dismissPopup: () => set({ popup: null }),

    markRead: async (id) => {
      try {
        await markNotificationReadApi(id)
      } catch {
        // 标记失败不阻断前端状态收敛
      }
      const cur = get()
      set({
        unread: Math.max(0, cur.unread - 1),
        popup: cur.popup?.id === id ? null : cur.popup,
      })
    },

    markAllRead: async () => {
      try {
        await markAllNotificationsReadApi()
      } catch {
        // 标记失败不阻断前端状态收敛
      }
      set({ unread: 0 })
    },

    decrementUnread: (wasUnread) => {
      if (!wasUnread) return
      set({ unread: Math.max(0, get().unread - 1) })
    },

    fetchUnread: async () => {
      try {
        const n = await getUnreadCountApi()
        set({ unread: Math.max(0, n) })
      } catch {
        // 未登录或失败静默
      }
    },

    reset: () => set({ unread: 0, popup: null }),
  }),
)
