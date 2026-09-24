"use client"

import { useEffect } from "react"
import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import {
  LayoutDashboard,
  Users,
  Settings,
  Bot,
  Search,
  Bell,
  Activity,
  Timer,
  Key,
  Cable,
  LineChart,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { useAuthStore } from "@/stores/auth"
import { useAuthGuard } from "@/hooks/auth"

/** 管理端菜单 —— 仅上线已对接真实后端的页面 */
const ADMIN_MENU = [
  { icon: LayoutDashboard, label: "仪表盘", path: "/admin/dashboard" },
  { icon: Users, label: "用户管理", path: "/admin/users" },
  { icon: Bot, label: "AI 监管", path: "/admin/ai" },
  { icon: Settings, label: "系统设置", path: "/admin/settings" },
  { icon: Activity, label: "渠道监控", path: "/admin/channels" },
  { icon: LineChart, label: "K线任务", path: "/admin/kline-tasks" },
  { icon: Cable, label: "VVTR 数据源", path: "/admin/vvtr" },
  { icon: Timer, label: "刷新节奏", path: "/admin/refresh-interval" },
  { icon: Key, label: "API Keys", path: "/admin/api-keys" },
]

/** 管理端 Layout Shell —— 强制 admin 角色 */
export default function AdminLayout({
  children,
}: {
  children: React.ReactNode
}): React.JSX.Element {
  const pathname = usePathname()
  const router = useRouter()
  const user = useAuthStore((s) => s.user)
  const accessToken = useAuthStore((s) => s.accessToken)
  const loaded = useAuthStore((s) => s.loaded)

  // 与用户端共用会话恢复（/me + 本地缓存）
  useAuthGuard()

  useEffect(() => {
    if (!loaded) return
    if (!accessToken) {
      router.replace("/login")
      return
    }
    if (user && user.role !== "admin") {
      router.replace("/dashboard")
    }
  }, [loaded, accessToken, user, router])

  return (
    <div className="flex flex-col h-screen overflow-hidden bg-[var(--bg-primary)]">
      <header className="h-[56px] flex items-center justify-between px-4 border-b border-[var(--border)] bg-[var(--bg-secondary)] shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded bg-[var(--accent-warn)] flex items-center justify-center text-white font-bold text-sm">
            A
          </div>
          <span className="text-[var(--text-primary)] font-semibold">
            管理后台
          </span>
          {user?.username && (
            <span className="text-xs text-[var(--text-muted)]">
              @{user.username}
              {user.role === "admin" ? " · 管理员" : ""}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          <button
            type="button"
            className="flex items-center gap-2 px-3 py-1.5 rounded-md bg-[var(--bg-tertiary)] text-[var(--text-muted)] text-sm"
          >
            <Search className="w-4 h-4" />
            搜索
          </button>
          <button
            type="button"
            className="p-2 rounded-md hover:bg-[var(--bg-tertiary)]"
          >
            <Bell className="w-4 h-4 text-[var(--text-secondary)]" />
          </button>
          <Link
            href="/dashboard"
            className="text-sm text-[var(--primary)] hover:underline"
          >
            返回用户端
          </Link>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        <aside className="w-[200px] h-full border-r border-[var(--border)] bg-[var(--bg-secondary)] shrink-0">
          <nav className="py-2">
            {ADMIN_MENU.map((item) => {
              const Icon = item.icon
              const isActive =
                pathname === item.path || pathname.startsWith(`${item.path}/`)
              return (
                <Link
                  key={item.path}
                  href={item.path}
                  className={cn(
                    "flex items-center gap-3 px-4 py-2.5 mx-2 rounded-md transition-colors text-sm",
                    isActive
                      ? "bg-[var(--primary)]/20 text-[var(--primary)]"
                      : "text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]",
                  )}
                >
                  <Icon className="w-4 h-4" />
                  <span>{item.label}</span>
                </Link>
              )
            })}
          </nav>
        </aside>

        <main className="flex-1 overflow-auto">{children}</main>
      </div>
    </div>
  )
}
