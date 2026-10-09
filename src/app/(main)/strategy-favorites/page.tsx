"use client"

/**
 * 策略收藏夹 —— 因子收藏 / AI 任务收藏（侧边栏入口页）
 *
 * 两类收藏各自独立的一级文件夹；因子可拖拽归类，
 * 任务收藏可看运行历史/决策、改参数（运行中禁改）、克隆。
 */

import { useState } from "react"
import { cn } from "@/lib/utils"
import { FactorFavoritesPanel } from "@/components/strategy-favorites/factor-favorites-panel"
import { ShortlineFavoritesPanel } from "@/components/strategy-favorites/shortline-favorites-panel"
import { TaskFavoritesPanel } from "@/components/strategy-favorites/task-favorites-panel"
import { FavoriteTransferToolbar } from "@/components/strategy-favorites/transfer-controls"

type TabKey = "factor" | "shortline" | "task"

const TABS: Array<{ key: TabKey; label: string }> = [
  { key: "factor", label: "因子收藏夹" },
  { key: "shortline", label: "短线因子收藏夹" },
  { key: "task", label: "AI 任务收藏夹" },
]

export default function StrategyFavoritesPage(): React.JSX.Element {
  const [tab, setTab] = useState<TabKey>("factor")

  return (
    <div className="h-full flex flex-col bg-[var(--bg-primary)]">
      <div className="px-3 py-2 border-b border-[var(--border)]"><FavoriteTransferToolbar kind="all" /></div>
      {/* 顶部标签切换（普通按钮实现，内容按状态渲染，避免 Radix Tabs 上下文） */}
      <div className="px-3 pt-2 border-b border-[var(--border)] bg-[var(--bg-secondary)] flex gap-1">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={cn(
              "px-3 h-8 rounded-md text-xs transition-colors cursor-pointer",
              tab === t.key
                ? "bg-[var(--bg-tertiary)] text-[var(--text-primary)]"
                : "text-[var(--text-muted)] hover:text-[var(--text-secondary)]",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="flex-1 min-h-0">
        {tab === "factor" ? (
          <FactorFavoritesPanel />
        ) : tab === "shortline" ? (
          <ShortlineFavoritesPanel />
        ) : (
          <TaskFavoritesPanel />
        )}
      </div>
    </div>
  )
}
