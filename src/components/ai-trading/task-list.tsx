"use client"

import { Star } from "lucide-react"
import { cn } from "@/lib/utils"
import type { AITradingTask } from "@/lib/ai-trading-api"
import { TaskIcon } from "@/components/ai-trading/task-icon"
import { TaskActions } from "@/components/ai-trading/task-actions"
import { useMarketStore } from "@/stores/market"
import {
  livePnl,
  runtimeLabel,
  STATUS_LABEL,
  STATUS_STYLE,
  statusKey,
  strategyLabel,
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
}

/** 价格自适应精度：≥1000→1 位；≥1→2 位；<1→4 位（微价格币不丢精度） */
function fmtPx(p: number): string {
  if (!Number.isFinite(p) || p <= 0) return "--"
  return p >= 1000 ? p.toFixed(1) : p >= 1 ? p.toFixed(2) : p.toFixed(4)
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

        const total = Number(task.total_realized_pnl ?? 0)
        const hasTotal = task.total_realized_pnl != null && total !== 0
        const totalColor = total > 0 ? "text-up" : total < 0 ? "text-down" : "text-[var(--text-muted)]"
        const pnlColor = pnl > 0 ? "text-up" : pnl < 0 ? "text-down" : "text-[var(--text-muted)]"
        const totalTrades = Number(task.trade_count ?? 0)

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
              "rounded-xl border p-3 transition-colors cursor-pointer h-full flex flex-col min-h-[172px]",
              selectedId === task.id
                ? "border-[var(--primary)] bg-[var(--primary)]/10"
                : "border-[var(--border)] bg-[var(--bg-secondary)] hover:bg-[var(--bg-tertiary)]",
            )}
          >
            {/* 头部：图标 + 名称 + 状态徽章 + 星标 */}
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
                <div className="flex items-center gap-1.5">
                  <span className="font-medium text-sm text-[var(--text-primary)] truncate">
                    {task.name}
                  </span>
                  <span
                    className={cn(
                      "text-[10px] px-1.5 py-0.5 rounded shrink-0",
                      STATUS_STYLE[sk] ?? STATUS_STYLE.stopped,
                    )}
                  >
                    {STATUS_LABEL[sk] ?? task.status}
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
                </div>
                <div className="mt-0.5 text-[11px] text-[var(--text-muted)] truncate flex items-center gap-1">
                  <span className="truncate">
                    {task.symbol_name || task.symbol} · {task.timeframe} ·{" "}
                    {strategyLabel(task)}
                  </span>
                  {Number(task.leverage ?? 0) > 0 && (
                    <span
                      className="shrink-0 px-1 rounded bg-amber-500/15 text-amber-300 font-num text-[10px]"
                      title={
                        task.margin_per_trade
                          ? `每笔保证金 ${Number(task.margin_per_trade)} USDT × ${task.leverage} 倍杠杆（后续新开仓生效）`
                          : `${task.leverage} 倍杠杆`
                      }
                    >
                      {task.margin_per_trade
                        ? `${Number(task.margin_per_trade).toLocaleString("zh-CN", { maximumFractionDigits: 2 })}U×${task.leverage}倍`
                        : `${task.leverage}倍`}
                    </span>
                  )}
                  {task.position_opened_at != null &&
                    task.hold_days_left != null &&
                    Number(task.max_hold_days ?? 0) > 0 && (
                      <span
                        className={cn(
                          "shrink-0 px-1 rounded font-num text-[10px]",
                          task.hold_days_left <= 3
                            ? "bg-red-500/15 text-red-300"
                            : "bg-white/5 text-[var(--text-muted)]",
                        )}
                        title={`总周期 ${task.max_hold_days} 天，还剩 ${task.hold_days_left} 天（北京自然日，每过 0 点 -1，剩 0 天强制平仓）`}
                      >
                        剩{task.hold_days_left}天
                      </span>
                    )}
                </div>
              </div>
            </div>

            {/* 统计条：累计盈亏 / 浮动盈亏 / 胜率 */}
            <div className="mt-2.5 grid grid-cols-3 gap-1 rounded-lg bg-[var(--bg-tertiary)]/50 px-2 py-1.5">
              <div
                className="min-w-0"
                title="累计盈亏：已平仓交易盈亏合计（含手续费）"
              >
                <div className="text-[10px] text-[var(--text-muted)]">累计盈亏</div>
                <div
                  className={cn(
                    "font-num text-sm font-semibold truncate",
                    totalColor,
                  )}
                >
                  {hasTotal ? (total > 0 ? "+" : "") + total.toFixed(2) : "0.00"}
                </div>
              </div>
              <div
                className="min-w-0 border-l border-[var(--border)]/60 pl-2"
                title="当前持仓浮动盈亏（未平仓）"
              >
                <div className="text-[10px] text-[var(--text-muted)]">浮动盈亏</div>
                <div
                  className={cn(
                    "font-num text-sm font-semibold truncate",
                    pnlColor,
                  )}
                >
                  {pos.hasPosition
                    ? (pnl > 0 ? "+" : "") + pnl.toFixed(2)
                    : "0.00"}
                </div>
              </div>
              <div
                className="min-w-0 border-l border-[var(--border)]/60 pl-2"
                title="胜率（盈利平仓 / 总平仓）"
              >
                <div className="text-[10px] text-[var(--text-muted)]">胜率</div>
                <div className="font-num text-sm font-semibold text-[var(--text-secondary)] truncate">
                  {totalTrades > 0
                    ? Number(task.win_rate ?? 0).toFixed(1) + "%"
                    : "--"}
                  {totalTrades > 0 && (
                    <span className="ml-1.5 text-[10px] font-normal text-[var(--text-muted)] whitespace-nowrap">
                      ({task.win_count}/{totalTrades})
                    </span>
                  )}
                </div>
              </div>
            </div>

            {task.note && (
              <p className="mt-1.5 text-[11px] text-amber-400/90 truncate">
                {task.note}
              </p>
            )}

            {/* 底部：持仓明细（方向+数量 开→现价）+ 运行时长/操作 */}
            <div className="mt-auto pt-2 border-t border-white/5 flex items-center justify-between gap-2">
              {pos.hasPosition && pos.avg != null ? (
                <div className="flex items-center gap-1.5 text-[11px] font-num min-w-0">
                  {dirLabel && (
                    <span
                      className={cn(
                        "px-1.5 py-0.5 rounded text-[10px] font-medium shrink-0",
                        dirLabel === "多"
                          ? "bg-red-500/15 text-up"
                          : "bg-emerald-500/15 text-down",
                      )}
                    >
                      {dirLabel}{" "}
                      {Number(pos.qty).toLocaleString("zh-CN", {
                        maximumFractionDigits: 4,
                      })}
                    </span>
                  )}
                  <span className="text-[var(--text-muted)] truncate">
                    {fmtPx(Number(pos.avg))}
                    <span className="mx-0.5 opacity-50">→</span>
                    <span className="text-[var(--text-secondary)]">
                      {pos.last != null ? fmtPx(Number(pos.last)) : "--"}
                    </span>
                  </span>
                </div>
              ) : (
                <span className="text-[11px] text-[var(--text-muted)] truncate">
                  未持仓{runtimeLabel(task) ? " · " + runtimeLabel(task) : ""}
                </span>
              )}
              <TaskActions
                task={task}
                compact
                onEdit={onEdit}
                onEditRules={onEditRules}
              />
            </div>
          </div>
        )
      })}
    </div>
  )
}
