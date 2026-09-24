"use client"

/**
 * AI 看盘行情 —— 左侧任务列表（替代行情页品种列表）
 *
 * 分「AI任务」「量化任务」两组（对应 AI 交易页的 AI交易/量化交易分类，
 * 按 strategy_type 区分）。选中任务 → 切换全局合约（K线/盘口联动）
 * 并加载该任务隔离的 K 线交易标记。浮盈用 WS 最新价实时缩放。
 */

import { useEffect, useMemo, useState } from "react"
import { RefreshCw, Search } from "lucide-react"
import { cn } from "@/lib/utils"
import type { AITradingTask } from "@/lib/ai-trading-api"
import { TaskIcon } from "@/components/ai-trading/task-icon"
import { livePnl, statusKey, STATUS_LABEL } from "@/components/ai-trading/task-list-helpers"
import { useAiMarketStore } from "@/stores/ai-market"
import { useMarketStore } from "@/stores/market"
import { useAppStore } from "@/stores/app"

const POLL_MS = 3_000

function isQuantTask(task: AITradingTask): boolean {
  return String(task.strategy_type ?? "ai").toLowerCase() !== "ai"
}

/** 单个任务行 */
function TaskRow({
  task,
  selected,
  onSelect,
}: {
  task: AITradingTask
  selected: boolean
  onSelect: () => void
}): React.JSX.Element {
  const quote = useMarketStore(
    (s) =>
      s.quotes[task.symbol] ??
      s.quotes[task.symbol.toLowerCase()] ??
      s.quotes[task.symbol.toUpperCase()]
  )
  const pnl = livePnl(task, quote?.last_price)
  const sk = statusKey(task)

  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "w-full text-left px-2 py-1.5 rounded-md transition-colors cursor-pointer",
        selected
          ? "bg-[var(--primary)]/15 ring-1 ring-[var(--primary)]/40"
          : "hover:bg-[var(--bg-tertiary)]",
      )}
    >
      <div className="flex items-center gap-1.5 min-w-0">
        <TaskIcon
          icon={task.icon}
          modelId={task.model_id}
          providerName={task.provider_name}
          displayName={task.model_display_name}
          strategyType={task.strategy_type}
          size={18}
        />
        <span
          className={cn(
            "text-[10px] px-1 rounded shrink-0",
            sk === "running"
              ? "bg-emerald-500/15 text-emerald-400"
              : sk === "paused"
                ? "bg-amber-500/15 text-amber-400"
                : sk === "market_closed"
                  ? "bg-sky-500/15 text-sky-400"
                  : "bg-zinc-500/15 text-zinc-400",
          )}
        >
          {STATUS_LABEL[sk] ?? task.status}
        </span>
        <span className="text-xs truncate flex-1 text-[var(--text-primary)]">
          {task.name}
        </span>
      </div>
      <div className="flex items-center justify-between mt-0.5 pl-[24px] text-[10px]">
        <span className="text-[var(--text-muted)] font-num truncate">
          {task.symbol} · {task.timeframe}
        </span>
        {pnl.hasPosition && (
          <span
            className={cn(
              "font-num font-semibold ml-1 shrink-0",
              pnl.pnl > 0 ? "text-up" : pnl.pnl < 0 ? "text-down" : "",
            )}
          >
            {pnl.pnl > 0 ? "+" : ""}
            {pnl.pnl.toFixed(0)}
          </span>
        )}
      </div>
    </button>
  )
}

/** 左侧任务列表面板 */
export function TaskWatchList(): React.JSX.Element {
  const tasks = useAiMarketStore((s) => s.tasks)
  const tasksLoading = useAiMarketStore((s) => s.tasksLoading)
  const selectedTaskId = useAiMarketStore((s) => s.selectedTaskId)
  const selectTask = useAiMarketStore((s) => s.selectTask)
  const loadTasks = useAiMarketStore((s) => s.loadTasks)
  const activeContract = useAppStore((s) => s.activeContract)
  const [keyword, setKeyword] = useState("")

  // 轮询任务列表（3s 静默），浮盈/状态实时更新
  useEffect(() => {
    void loadTasks()
    const timer = setInterval(() => void loadTasks(true), POLL_MS)
    return () => clearInterval(timer)
  }, [loadTasks])

  const { aiTasks, quantTasks } = useMemo(() => {
    const kw = keyword.trim().toLowerCase()
    const match = (t: AITradingTask) =>
      !kw ||
      t.name.toLowerCase().includes(kw) ||
      t.symbol.toLowerCase().includes(kw) ||
      (t.symbol_name ?? "").toLowerCase().includes(kw)
    return {
      aiTasks: tasks.filter((t) => !isQuantTask(t) && match(t)),
      quantTasks: tasks.filter((t) => isQuantTask(t) && match(t)),
    }
  }, [tasks, keyword])

  return (
    <div className="flex flex-col h-full">
      {/* 搜索 + 刷新 */}
      <div className="flex items-center gap-1 px-2 py-1.5 border-b border-[var(--border)]">
        <div className="relative flex-1">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[var(--text-muted)]" />
          <input
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="搜索任务/品种"
            className="w-full h-7 pl-7 pr-2 rounded-md text-xs bg-[var(--bg-tertiary)] border border-[var(--border)] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] outline-none focus:border-[var(--primary)]/50"
          />
        </div>
        <button
          type="button"
          onClick={() => void loadTasks()}
          title="刷新任务列表"
          className="p-1.5 rounded-md text-[var(--text-muted)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)] transition-colors cursor-pointer"
        >
          <RefreshCw className={cn("w-3.5 h-3.5", tasksLoading && "animate-spin")} />
        </button>
      </div>

      {/* 分组列表 */}
      <div className="flex-1 min-h-0 overflow-y-auto px-1.5 py-1 space-y-2">
        {tasks.length === 0 && !tasksLoading && (
          <div className="text-xs text-[var(--text-muted)] text-center py-8">
            暂无任务
            <br />
            <span className="text-[10px]">去「AI 交易」页创建任务</span>
          </div>
        )}
        {tasksLoading && tasks.length === 0 && (
          <div className="text-xs text-[var(--text-muted)] text-center py-8">
            加载中…
          </div>
        )}

        {aiTasks.length > 0 && (
          <div>
            <div className="flex items-center gap-1 px-1 py-0.5">
              <span className="text-[10px] font-semibold text-[var(--primary)]">
                AI任务
              </span>
              <span className="text-[10px] text-[var(--text-muted)]">
                {aiTasks.length}
              </span>
            </div>
            <div className="space-y-0.5">
              {aiTasks.map((t) => (
                <TaskRow
                  key={t.id}
                  task={t}
                  selected={t.id === selectedTaskId}
                  onSelect={() => selectTask(t.id)}
                />
              ))}
            </div>
          </div>
        )}

        {quantTasks.length > 0 && (
          <div>
            <div className="flex items-center gap-1 px-1 py-0.5">
              <span className="text-[10px] font-semibold text-emerald-400">
                量化任务
              </span>
              <span className="text-[10px] text-[var(--text-muted)]">
                {quantTasks.length}
              </span>
            </div>
            <div className="space-y-0.5">
              {quantTasks.map((t) => (
                <TaskRow
                  key={t.id}
                  task={t}
                  selected={t.id === selectedTaskId}
                  onSelect={() => selectTask(t.id)}
                />
              ))}
            </div>
          </div>
        )}
      </div>

      {/* 底部：当前任务品种（与全局合约一致性提示） */}
      <div className="px-2 py-1 border-t border-[var(--border)] text-[10px] text-[var(--text-muted)] truncate">
        合约 {activeContract}
      </div>
    </div>
  )
}
