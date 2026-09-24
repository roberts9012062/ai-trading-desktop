"use client"

import { useEffect } from "react"
import { useRouter } from "next/navigation"
import * as DropdownMenu from "@radix-ui/react-dropdown-menu"
import { Bell, Search, ChevronDown, Circle, LogOut, User, Shield } from "lucide-react"
import { useAppStore } from "@/stores/app"
import { useAuthStore } from "@/stores/auth"
import { useNotificationsStore } from "@/stores/notifications"
import { useSessionStatus } from "@/hooks/use-session-status"
import { cn } from "@/lib/utils"

/** 市场状态配置 */
const MARKET_STATUS_MAP = {
  trading: { color: "bg-[var(--accent-down)]", label: "交易中" },
  closed: { color: "bg-[var(--accent-warn)]", label: "休市" },
  offline: { color: "bg-[var(--accent-danger)] animate-pulse", label: "断线" },
} as const

/** 顶部导航栏（56px 固定高度） */
export function TopNavbar(): React.JSX.Element {
  const router = useRouter()
  const { marketStatus, setMarketStatus, setSearchOpen, activeContract } = useAppStore()
  const { user, logout } = useAuthStore()
  const { status: session, isOpen, hasVirtualQuote } = useSessionStatus(activeContract)
  const isVirtual =
    user?.trading_mode === "virtual" || session?.trading_mode === "virtual"

  // 通知未读数：订阅 store 单一数据源（顶栏红点 / 消息页 / 弹窗共用）。
  // WS 推送、消息页标记已读均实时写入 store，顶栏自动更新。
  // 仅保留低频兜底轮询，防止 WS 断线时数字僵死；写入 store 而非本地 state。
  const unread = useNotificationsStore((s) => s.unread)
  const fetchUnread = useNotificationsStore((s) => s.fetchUnread)
  useEffect(() => {
    if (!user) return
    void fetchUnread()
    const t = setInterval(() => void fetchUnread(), 60_000)
    return () => clearInterval(t)
  }, [user, fetchUnread])

  useEffect(() => {
    // 虚拟盘 7×24：顶栏状态灯恒为交易中，不跟国内周末休市
    if (isVirtual) {
      setMarketStatus("trading")
      return
    }
    if (session) {
      setMarketStatus(isOpen ? "trading" : "closed")
    }
  }, [session, isOpen, isVirtual, setMarketStatus])

  const status = MARKET_STATUS_MAP[marketStatus]
  const statusLabel = isVirtual
    ? hasVirtualQuote === false
      ? "虚拟盘 · 暂无行情"
      : "虚拟盘 · 7×24"
    : session
      ? isOpen
        ? `交易中 · ${session.product_code}`
        : `休市 · ${session.product_code}`
      : status.label

  // user 未恢复前不显示「用户」，避免被误认为角色变成普通用户
  const displayName: string = user?.username ?? "加载中…"
  const displayInitial: string = user?.username
    ? user.username.charAt(0).toUpperCase()
    : "?"
  const modeLabel =
    user?.trading_mode === "virtual" ? "虚拟盘" : "实盘"

  /** 退出登录 */
  const handleLogout = (): void => {
    logout()
    router.replace("/login")
  }

  return (
    <header className="h-[56px] flex items-center justify-between px-4 border-b border-[var(--border)] bg-[var(--bg-secondary)] shrink-0 z-30">
      {/* 左侧：Logo + 状态灯 */}
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded bg-[var(--primary)] flex items-center justify-center text-white font-bold text-sm">
            Q
          </div>
          <span className="text-[var(--text-primary)] font-semibold text-base hidden sm:inline">
            期货交易系统
          </span>
        </div>
        <div
          className="flex items-center gap-1.5 text-xs text-[var(--text-muted)]"
          title={session?.message ?? statusLabel}
        >
          <Circle className={cn("w-2 h-2 fill-current", status.color)} />
          <span>{statusLabel}</span>
        </div>
        {user && (
          <span
            className={cn(
              "text-[10px] px-2 py-0.5 rounded border",
              user.trading_mode === "virtual"
                ? "border-[var(--accent-warn)]/40 text-[var(--accent-warn)]"
                : "border-[var(--primary)]/40 text-[var(--primary)]",
            )}
            title="登录时选定，会话内不可切换"
          >
            {modeLabel}
          </span>
        )}
      </div>

      {/* 右侧：搜索、通知、用户菜单 */}
      <div className="flex items-center gap-3">
        {/* 合约搜索按钮 */}
        <button
          onClick={() => setSearchOpen(true)}
          className="flex items-center gap-2 px-3 py-1.5 rounded-md bg-[var(--bg-tertiary)] text-[var(--text-muted)] text-sm hover:bg-[var(--border)] transition-colors cursor-pointer"
        >
          <Search className="w-4 h-4" />
          <span className="hidden sm:inline">搜索合约</span>
          <kbd className="hidden md:inline text-xs px-1.5 py-0.5 rounded bg-[var(--bg-primary)] border border-[var(--border)]">
            Ctrl+K
          </kbd>
        </button>

        {/* 通知图标 */}
        <button
          onClick={() => router.push("/messages")}
          title="消息中心"
          className="relative p-2 rounded-md hover:bg-[var(--bg-tertiary)] transition-colors cursor-pointer"
        >
          <Bell className="w-4 h-4 text-[var(--text-secondary)]" />
          {unread > 0 && (
            <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 px-1 rounded-full bg-[var(--accent-danger)] text-white text-[10px] font-num flex items-center justify-center">
              {unread > 99 ? "99+" : unread}
            </span>
          )}
        </button>

        {/* 用户下拉菜单 */}
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button className="flex items-center gap-2 px-2 py-1 rounded-md hover:bg-[var(--bg-tertiary)] transition-colors cursor-pointer outline-none">
              <div className="w-7 h-7 rounded-full bg-[var(--primary)] flex items-center justify-center text-white text-xs font-medium">
                {displayInitial}
              </div>
              <span className="text-sm text-[var(--text-secondary)] hidden sm:inline">{displayName}</span>
              <ChevronDown className="w-3 h-3 text-[var(--text-muted)]" />
            </button>
          </DropdownMenu.Trigger>

          <DropdownMenu.Portal>
            <DropdownMenu.Content
              align="end"
              sideOffset={8}
              className="min-w-[160px] rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] p-1.5 shadow-xl z-50 animate-in fade-in-0 zoom-in-95"
            >
              {/* 用户信息 */}
              <DropdownMenu.Label className="px-3 py-2 text-xs text-[var(--text-muted)]">
                <User className="w-3 h-3 inline mr-1.5 -mt-0.5" />
                {displayName}
                {user?.role === "admin" ? " · 管理员" : ""}
              </DropdownMenu.Label>
              <DropdownMenu.Separator className="h-px bg-[var(--border)] my-1" />

              {user?.role === "admin" && (
                <DropdownMenu.Item
                  onSelect={() => router.push("/admin/dashboard")}
                  className="flex items-center gap-2 px-3 py-2 text-sm text-[var(--text-primary)] rounded-md cursor-pointer outline-none hover:bg-[var(--bg-tertiary)] transition-colors"
                >
                  <Shield className="w-4 h-4" />
                  管理后台
                </DropdownMenu.Item>
              )}

              {/* 退出登录 */}
              <DropdownMenu.Item
                onSelect={handleLogout}
                className="flex items-center gap-2 px-3 py-2 text-sm text-[var(--accent-danger)] rounded-md cursor-pointer outline-none hover:bg-[var(--bg-tertiary)] transition-colors"
              >
                <LogOut className="w-4 h-4" />
                退出登录
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>
    </header>
  )
}
