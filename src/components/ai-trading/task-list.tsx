"use client"

import { Star } from "lucide-react"
import { cn } from "@/lib/utils"
import type { AITradingTask } from "@/lib/ai-trading-api"
import { switchTaskSite } from "@/lib/ai-trading-api"
import { TaskIcon } from "@/components/ai-trading/task-icon"
import { TaskActions } from "@/components/ai-trading/task-actions"
import { useMarketStore } from "@/stores/market"
import {
  holdDaysLabel,
  livePnl,
  qtyLabel,
  runtimeLabel,
  SIDE_LABEL,
  STATUS_LABEL,
  STATUS_STYLE,
  statusKey,
  strategyLabel,
  winRateLabel,
} from "./task-list-helpers"

interface TaskListProps {
  tasks: AITradingTask[]
  selectedId: string | null
  onSelect: (id: string) => void
  onEdit?: (task: AITradingTask) => void
  /** 无持仓时调整盈亏比例（运行中也允许） */
  onEditRules?: (task: AITradingTask) => void
  /** 已收藏任务 id 集合（星标常亮） */
  favoritedIds?: Set<string>
  /** 点星标收藏（弹出选文件夹） */
  onFavorite?: (task: AITradingTask) => void
  /** 执行位置切换成功后刷新列表 */
  onRefresh?: () => void
}

/** 任务列表 —— 九宫格卡片 */
export function TaskList({
  tasks,
  selectedId,
  onSelect,
  onEdit,
  onEditRules,
  favoritedIds,
  onFavorite,
  onRefresh,
}: TaskListProps): React.JSX.Element {
  const quotes = useMarketStore((s) => s.quotes)

  if (tasks.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-[var(--border)] p-8 text-center text-sm text-[var(--text-muted)]">
        暂无 AI 交易任务，点击右上角创建
      </div>
    )
  }

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
      {tasks.map((task) => {
        const sk = statusKey(task)
        const sym = (task.symbol || "").toLowerCase()
        const q =
          quotes[sym] ??
          quotes[task.symbol] ??
          quotes[task.symbol?.toUpperCase?.() || ""]
        const pos = livePnl(task, q?.last_price)
        const pnl = pos.hasPosition ? pos.pnl : 0
        const base = Number(task.allocated_capital || task.equity_baseline || 0)
        const pct = base > 0 ? (pnl / base) * 100 : 0
        const dirLabel =
          pos.direction === "long"
            ? "多"
            : pos.direction === "short"
              ? "空"
              : null

        return (
          <div
            key={task.id}
            role="button"
            tabIndex={0}
            onClick={() => onSelect(task.id)}
            onKeyDown={(e) => {
              if (e.key === "Enter") onSelect(task.id)
            }}
            className={cn(
              "rounded-xl border p-3 transition-colors cursor-pointer h-full flex flex-col min-h-[168px]",
              selectedId === task.id
                ? "border-[var(--primary)] bg-[var(--primary)]/10"
                : "border-[var(--border)] bg-[var(--bg-secondary)] hover:bg-[var(--bg-tertiary)]",
            )}
          >
            <div className="flex items-start gap-2.5">
              <TaskIcon
                icon={task.icon}
                strategyType={task.strategy_type}
                modelId={task.model_id}
                providerName={task.provider_name}
                displayName={task.model_display_name}
                size={32}
              />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="font-medium text-sm text-[var(--text-primary)] truncate max-w-full">
                    {task.name}
                  </span>
                  {onFavorite && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation()
                        onFavorite(task)
                      }}
                      title={
                        favoritedIds?.has(task.id)
                          ? "已收藏，点击调整文件夹"
                          : "收藏到策略收藏夹"
                      }
                      className="ml-auto shrink-0 cursor-pointer"
                    >
                      <Star
                        className={cn(
                          "w-3.5 h-3.5",
                          favoritedIds?.has(task.id)
                            ? "fill-amber-400 text-amber-400"
                            : "text-[var(--text-muted)] hover:text-amber-300",
                        )}
                      />
                    </button>
                  )}
                  <span
                    className={cn(
                      "text-[10px] px-1.5 py-0.5 rounded shrink-0",
                      STATUS_STYLE[sk] ?? STATUS_STYLE.stopped,
                    )}
                  >
                    {STATUS_LABEL[sk] ?? task.status}
                  </span>
                  {dirLabel && (
                    <span
                      className={cn(
                        "text-[10px] px-1.5 py-0.5 rounded font-medium shrink-0",
                        dirLabel === "多"
                          ? "bg-red-500/15 text-up"
                          : "bg-emerald-500/15 text-down",
                      )}
                    >
                      {dirLabel} {pos.qty}手
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={async (e) => {
                      e.stopPropagation()
                      const site = (task as { execution_site?: string }).execution_site === "client" ? "server" : "client"
                      try {
                        await switchTaskSite(task.id, site)
                        onRefresh?.()
                      } catch (err) {
                        alert(
                          err instanceof Error && err.message.includes("404")
                            ? "服务端尚未部署本地引擎支持(分支 feat/ai-trading-client-engine)"
                            : `切换失败: ${err instanceof Error ? err.message : String(err)}`,
                        )
                      }
                    }}
                    title="切换执行位置:本地引擎在本机调度决策(应用需保持运行),服务端引擎 7x24"
                    className={cn(
                      "text-[10px] px-1.5 py-0.5 rounded shrink-0 border",
                      (task as { execution_site?: string }).execution_site === "client"
                        ? "border-emerald-600 text-emerald-400"
                        : "border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text-primary)]",
                    )}
                  >
                    {(task as { execution_site?: string }).execution_site === "client" ? "本地" : "服务端"}
                  </button>
                </div>
                <div className="mt-1 text-[11px] text-[var(--text-muted)] line-clamp-2 leading-relaxed">
                  <span>
                    {task.symbol_name || task.symbol} · {task.timeframe}
                  </span>
                  <span className="mx-1.5 opacity-40">·</span>
                  <span>{SIDE_LABEL[task.side_mode] ?? task.side_mode}</span>
                  <span className="mx-1.5 opacity-40">·</span>
                  <span>{qtyLabel(task)}</span>
                  <span className="mx-1.5 opacity-40">·</span>
                  <span>{strategyLabel(task)}</span>
                  {holdDaysLabel(task) && (
                    <>
                      <span className="mx-1.5 opacity-40">·</span>
                      <span>{holdDaysLabel(task)}</span>
                    </>
                  )}
                  {runtimeLabel(task) && (
                    <>
                      <span className="mx-1.5 opacity-40">·</span>
                      <span>{runtimeLabel(task)}</span>
                    </>
                  )}
                </div>
              </div>
            </div>

            <div className="mt-2.5 flex-1">
              {pos.hasPosition && pos.avg != null && pos.last != null ? (
                <div className="text-[11px] text-[var(--text-secondary)] flex flex-wrap gap-x-3 gap-y-0.5 font-num">
                  <span>
                    开{" "}
                    <span className="text-[var(--text-primary)]">
                      {Number(pos.avg).toFixed(Number(pos.avg) >= 1000 ? 1 : 2)}
                    </span>
                  </span>
                  <span>
                    新{" "}
                    <span className="text-[var(--text-primary)]">
                      {Number(pos.last).toFixed(
                        Number(pos.last) >= 1000 ? 1 : 2,
                      )}
                    </span>
                  </span>
                  <span
                    className={cn(
                      "font-medium",
                      pnl >= 0 ? "text-up" : "text-down",
                    )}
                  >
                    浮盈 {pnl >= 0 ? "+" : ""}
                    {pnl.toFixed(2)}
                  </span>
                </div>
              ) : (
                <div className="text-[11px] text-[var(--text-muted)]">
                  未持仓 · 浮盈 0.00
                </div>
              )}
              {task.note && (
                <p className="mt-1 text-[11px] text-amber-400/90 truncate">
                  {task.note}
                </p>
              )}
            </div>

            <div className="mt-2 pt-2 border-t border-white/5 flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                {pos.hasPosition ? (
                  <span
                    className={cn(
                      "text-sm font-num font-semibold",
                      pnl >= 0 ? "text-up" : "text-down",
                    )}
                  >
                    {pnl >= 0 ? "+" : ""}
                    {pnl.toFixed(2)}
                    {base > 0 && (
                      <span className="text-[11px] ml-1 opacity-80 font-normal">
                        ({pct >= 0 ? "+" : ""}
                        {pct.toFixed(2)}%)
                      </span>
                    )}
                  </span>
                ) : (
                  <span className="text-sm font-num text-[var(--text-muted)]">
                    +0.00
                  </span>
                )}
                <span className="text-[11px] text-[var(--text-muted)] font-num truncate">
                  {winRateLabel(task)}
                </span>
              </div>
              <TaskActions task={task} compact onEdit={onEdit} onEditRules={onEditRules} />
            </div>
          </div>
        )
      })}
    </div>
  )
}
