"use client"

import { useEffect, useState } from "react"
import { usePathname } from "next/navigation"
import Link from "next/link"
import {
  LayoutDashboard, BarChart3, LineChart,
  Briefcase, FileText, Wallet, Crown,
  User, MessageSquare, ChevronLeft, ChevronRight,
  ChevronDown, Bot, Sparkles, FlaskConical,
  Dna, Cpu, Radar, Bookmark, Filter,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { useAppStore } from "@/stores/app"
import { UpdateControl } from "@/components/layout/update-control"

interface MenuItem {
  icon: typeof LayoutDashboard
  label: string
  path: string
  demo?: boolean
  /** 二级子菜单（仅一级项持有；默认路由到主路径） */
  children?: Array<{ label: string; path: string }>
}

/** 侧边栏菜单项配置（demo=true 表示仍为前端 mock） */
const MENU_ITEMS: MenuItem[] = [
  { icon: LayoutDashboard, label: "工作台", path: "/dashboard", demo: false },
  {
    icon: BarChart3,
    label: "行情",
    path: "/market",
    demo: false,
    children: [
      { label: "行情总览", path: "/market" },
      { label: "行情筛选", path: "/market/screener" },
    ],
  },
  {
    icon: Radar,
    label: "AI看盘行情",
    path: "/ai-market",
    demo: false,
    children: [
      { label: "看盘任务", path: "/ai-market" },
      { label: "成交量分布", path: "/ai-market/volume-profile" },
    ],
  },
  { icon: LineChart, label: "交易", path: "/trading", demo: false },
  { icon: Sparkles, label: "AI 交易", path: "/ai-trading", demo: false },
  { icon: FlaskConical, label: "历史回测", path: "/backtest", demo: false },
  {
    icon: Dna,
    label: "因子实验室",
    path: "/factor-lab",
    demo: false,
    children: [
      { label: "因子实验室", path: "/factor-lab" },
      { label: "短线因子实验室", path: "/factor-lab/shortline" },
    ],
  },
  { icon: Bookmark, label: "策略收藏夹", path: "/strategy-favorites", demo: false },
  { icon: Briefcase, label: "持仓", path: "/positions", demo: false },
  { icon: FileText, label: "订单", path: "/orders", demo: false },
  { icon: Wallet, label: "资产", path: "/assets", demo: false },
  { icon: Crown, label: "商城 VIP", path: "/mall", demo: false },
  { icon: Cpu, label: "超级因子", path: "/history", demo: false },
  { icon: User, label: "个人", path: "/profile", demo: false },
  { icon: Bot, label: "AI 设置", path: "/ai-settings", demo: false },
  { icon: MessageSquare, label: "消息", path: "/messages", demo: true },
]

/** 可折叠侧边栏（192px ↔ 48px），支持行情二级子菜单 */
export function Sidebar(): React.JSX.Element {
  const pathname = usePathname()
  const { sidebarCollapsed, toggleSidebar } = useAppStore()
  const [expandedMenu, setExpandedMenu] = useState<string | null>(null)
  // 商城关闭后隐藏「商城 VIP」入口（后台开关，全站 VIP 功能免费开放）
  const [mallClosed, setMallClosed] = useState(false)

  useEffect(() => {
    let alive = true
    import("@/lib/mall-api")
      .then((m) => m.getMallStatusApi())
      .then((s) => {
        if (alive) setMallClosed(Boolean(s.closed))
      })
      .catch(() => {
        // 查询失败不隐藏入口（保持商城可见）
      })
    return () => {
      alive = false
    }
  }, [])

  const items = mallClosed
    ? MENU_ITEMS.filter((i) => i.path !== "/mall")
    : MENU_ITEMS

  // 进入子菜单路由时自动展开对应一级项
  useEffect(() => {
    const parent = items.find(
      (item) =>
        item.children &&
        item.children.some((child) => child.path !== item.path && pathname === child.path),
    )
    if (parent) setExpandedMenu(parent.path)
  }, [pathname, items])

  return (
    <aside
      className={cn(
        "h-full flex flex-col border-r border-[var(--border)] bg-[var(--bg-secondary)] transition-all duration-200 shrink-0",
        sidebarCollapsed ? "w-[48px]" : "w-[192px]"
      )}
    >
      {/* 菜单列表 */}
      <nav className="flex-1 py-2 overflow-y-auto">
        {items.map((item) => {
          const isExact = pathname === item.path
          const isActive =
            isExact ||
            (item.path !== "/" && pathname.startsWith(item.path + "/"))
          const hasChildren = Boolean(item.children) && !sidebarCollapsed
          const expanded = expandedMenu === item.path
          const Icon = item.icon
          return (
            <div key={item.path}>
              <div className="relative group">
                <Link
                  href={item.path}
                  className={cn(
                    "flex items-center gap-3 px-3 py-2.5 mx-1.5 rounded-md transition-colors",
                    isActive && !hasChildren
                      ? "bg-[var(--primary)]/20 text-[var(--primary)]"
                      : isActive && hasChildren
                        ? "text-[var(--primary)]"
                        : "text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
                  )}
                >
                  <Icon className="w-5 h-5 shrink-0" />
                  {!sidebarCollapsed && (
                    <span className="text-sm truncate flex items-center gap-1.5 flex-1">
                      {item.label}
                      {item.demo && (
                        <span className="text-[10px] px-1 rounded bg-[var(--accent-warn)]/15 text-[var(--accent-warn)]">
                          演示
                        </span>
                      )}
                    </span>
                  )}
                  {/* 折叠时显示 tooltip */}
                  {sidebarCollapsed && (
                    <span className="absolute left-full ml-2 px-2 py-1 rounded bg-[var(--bg-tertiary)] text-xs text-[var(--text-primary)] whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-50">
                      {item.label}{item.demo ? "（演示）" : ""}
                    </span>
                  )}
                </Link>
                {/* 展开子菜单的开关（hover 区域覆盖在 Link 右侧） */}
                {hasChildren && (
                  <button
                    type="button"
                    aria-label={expanded ? "收起子菜单" : "展开子菜单"}
                    onClick={() =>
                      setExpandedMenu(expanded ? null : item.path)
                    }
                    className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-muted)] hover:text-[var(--text-primary)] cursor-pointer"
                  >
                    <ChevronDown
                      className={cn(
                        "w-3.5 h-3.5 transition-transform",
                        expanded && "rotate-180"
                      )}
                    />
                  </button>
                )}
              </div>

              {/* 二级子菜单：一级项下缩进展开 */}
              {hasChildren && expanded && (
                <div className="mx-1.5 mb-1 ml-5 pl-3 border-l border-[var(--border)]">
                  {item.children!.map((child) => {
                    const childActive = pathname === child.path
                    return (
                      <Link
                        key={child.path}
                        href={child.path}
                        className={cn(
                          "flex items-center gap-2 px-2 py-1.5 my-0.5 rounded text-[13px] transition-colors",
                          childActive
                            ? "bg-[var(--primary)]/20 text-[var(--primary)]"
                            : "text-[var(--text-muted)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
                        )}
                      >
                        {child.path === "/market/screener" ? (
                          <Filter className="w-3.5 h-3.5 shrink-0" />
                        ) : (
                          <span className="w-1 h-1 rounded-full bg-current shrink-0" />
                        )}
                        <span className="truncate">{child.label}</span>
                      </Link>
                    )
                  })}
                </div>
              )}
            </div>
          )
        })}
      </nav>

      {/* 检查更新(桌面端专属;网页端同步 sidebar 时勿删) */}
      <UpdateControl collapsed={sidebarCollapsed} />

      {/* 折叠按钮 */}
      <div className="p-2 border-t border-[var(--border)]">
        <button
          onClick={toggleSidebar}
          className="w-full flex items-center justify-center p-2 rounded-md text-[var(--text-muted)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)] transition-colors cursor-pointer"
        >
          {sidebarCollapsed ? (
            <ChevronRight className="w-4 h-4" />
          ) : (
            <ChevronLeft className="w-4 h-4" />
          )}
        </button>
      </div>
    </aside>
  )
}
