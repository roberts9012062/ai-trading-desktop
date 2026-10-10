"use client"

import { useEffect } from "react"
import { useRouter } from "next/navigation"
import { Bell, Search, Circle } from "lucide-react"
import { useAppStore } from "@/stores/app"
import { useAuthStore } from "@/stores/auth"
import { useNotificationsStore } from "@/stores/notifications"
import { useSessionStatus } from "@/hooks/use-session-status"
import { BrandLogo } from "@/components/common/brand-logo"
import { cn } from "@/lib/utils"
import { UserMenu } from "./user-menu"

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
  const { user } = useAuthStore()
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

  const modeLabel =
    user?.trading_mode === "virtual" ? "虚拟盘" : "实盘"

  return (
    <header className="h-[56px] flex items-center justify-between px-4 border-b border-[var(--border)] bg-[var(--bg-secondary)] shrink-0 z-30">
      {/* 左侧：Logo + 状态灯 */}
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2">
          <BrandLogo size={32} />
          <span className="text-[var(--text-primary)] font-semibold text-base hidden sm:inline">
            周期领航 · CyclePilot
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
        <UserMenu />
      </div>
    </header>
  )
}
