"use client"

import { create } from "zustand"
import { getMarketWebSocket } from "@/lib/websocket"
import { getOkxSnippetWebSocket } from "@/lib/okx-snippet-ws"
import { stopDesktopRouting } from "@/lib/desktop-routing"
import { disconnectDesktopExchange } from "@/lib/desktop-exchange"
import { stopSnippetPrivate } from "@/lib/snippet-private-ws"
import { resetDesktopDailyPnl } from "@/lib/desktop-daily-pnl"
import { useNotificationsStore } from "@/stores/notifications"
import type { User } from "@/types"
import { rememberAccount, forgetAccount } from "@/lib/account-profiles"

const ACCESS_KEY = "access_token"
const REFRESH_KEY = "refresh_token"
const USER_KEY = "qihuo_auth_user"

/** 从 localStorage 恢复用户（刷新后保持角色） */
function readCachedUser(): User | null {
  if (typeof window === "undefined") return null
  try {
    const raw = localStorage.getItem(USER_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as User
    if (!parsed?.id || !parsed?.username) return null
    // 角色只认 admin / user，避免脏数据
    const role = parsed.role === "admin" ? "admin" : "user"
    const trading_mode =
      parsed.trading_mode === "virtual" ? "virtual" : "live"
    return { ...parsed, role, trading_mode }
  } catch {
    return null
  }
}

function writeCachedUser(user: User | null): void {
  if (typeof window === "undefined") return
  try {
    if (user) {
      localStorage.setItem(USER_KEY, JSON.stringify(user))
    } else {
      localStorage.removeItem(USER_KEY)
    }
  } catch {
    // 隐私模式等写失败忽略
  }
}

/** 切换账号时清空交易内存态（持仓/委托/账户）。
 *  动态 import：paper-trading 顶层引用了本 store，静态互引会成环。 */
function resetTradingState(): void {
  void import("@/stores/paper-trading").then((m) => {
    m.usePaperTradingStore.getState().reset()
  })
}

interface AuthState {
  /** 当前用户 */
  user: User | null
  /** JWT access token */
  accessToken: string | null
  /** 是否已完成会话恢复（含 /me 校验） */
  loaded: boolean
  /** 是否正在拉取 /me */
  hydrating: boolean
  /** 登录 */
  login: (user: User, accessToken: string, refreshToken: string) => void
  /** 登出 */
  logout: () => void
  /** 更新用户信息 */
  updateUser: (user: Partial<User>) => void
  /** 设置 access token */
  setAccessToken: (token: string) => void
  /** 标记会话恢复完成 */
  setLoaded: (loaded: boolean) => void
  /** 标记 hydrating */
  setHydrating: (hydrating: boolean) => void
}

/** 认证状态管理 —— 用户信息本地缓存，刷新后不丢角色 */
export const useAuthStore = create<AuthState>((set, get) => ({
  user: typeof window !== "undefined" ? readCachedUser() : null,
  accessToken:
    typeof window !== "undefined" ? localStorage.getItem(ACCESS_KEY) : null,
  loaded: false,
  hydrating: false,

  login: (user, accessToken, refreshToken) => {
    rememberAccount({ user, accessToken, refreshToken })
    if (get().user && get().user?.id !== user.id) {
      try {
      getOkxSnippetWebSocket().disconnect()
      stopSnippetPrivate()
      disconnectDesktopExchange()
      stopDesktopRouting()
      getMarketWebSocket().disconnect()
      useNotificationsStore.getState().reset()
      } catch { /* Full reload also tears down the old native connections. */ }
    }
    resetDesktopDailyPnl()
    localStorage.setItem(ACCESS_KEY, accessToken)
    localStorage.setItem(REFRESH_KEY, refreshToken)
    writeCachedUser(user)
    // 账号会话边界：不得带入上一账号的持仓/委托/账户内存态
    resetTradingState()
    set({ user, accessToken, loaded: true, hydrating: false })
  },

  logout: () => {
    if (get().user) forgetAccount(get().user!.id)
    resetDesktopDailyPnl()
    localStorage.removeItem(ACCESS_KEY)
    localStorage.removeItem(REFRESH_KEY)
    writeCachedUser(null)
    try {
      getOkxSnippetWebSocket().disconnect()
      stopSnippetPrivate()
      disconnectDesktopExchange()
      stopDesktopRouting()
      getMarketWebSocket().disconnect()
    } catch {
      // ignore
    }
    // 清空通知状态，避免下一账号看到上一账号的未读红点 / 弹窗
    useNotificationsStore.getState().reset()
    // 清空交易内存态，避免下一账号看到上一账号的持仓 / 委托
    resetTradingState()
    set({ user: null, accessToken: null, loaded: true, hydrating: false })
  },

  updateUser: (partial) => {
    const prev = get().user
    if (!prev) return
    const next: User = { ...prev, ...partial }
    if (partial.role !== undefined) {
      next.role = partial.role === "admin" ? "admin" : "user"
    }
    writeCachedUser(next)
    set({ user: next })
  },

  setAccessToken: (token) => {
    localStorage.setItem(ACCESS_KEY, token)
    const user = get().user
    if (user) rememberAccount({ user, accessToken: token, refreshToken: localStorage.getItem(REFRESH_KEY) ?? "" })
    set({ accessToken: token })
  },

  setLoaded: (loaded) => set({ loaded }),
  setHydrating: (hydrating) => set({ hydrating }),
}))
