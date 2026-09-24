"use client"

import { useCallback, useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import {
  listAITradingTasks,
  type AITradingTask,
} from "@/lib/ai-trading-api"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"

const STATUS_LABEL: Record<string, string> = {
  running: "运行中",
  paused: "已暂停",
  market_closed: "休市暂停",
  stopped: "已结束",
}

function statusKey(task: AITradingTask): string {
  if (task.status === "paused" && task.pause_reason === "market_closed") {
    return "market_closed"
  }
  return String(task.status)
}

/** AI 交易概览 —— 任务统计与简表 */
export function AiTradingOverview(): React.JSX.Element {
  const router = useRouter()
  const [tasks, setTasks] = useState<AITradingTask[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    try {
      const data = await listAITradingTasks()
      setTasks(data.items || [])
    } catch {
      setTasks([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
    const timer = setInterval(load, 10000)
    return () => clearInterval(timer)
  }, [load])

  const running = tasks.filter((t) => t.status === "running").length
  const paused = tasks.filter((t) => t.status === "paused").length
  const marketClosed = tasks.filter(
    (t) => t.status === "paused" && t.pause_reason === "market_closed",
  ).length
  const stopped = tasks.filter((t) => t.status === "stopped").length
  const cashSum = tasks.reduce(
    (acc, t) => acc + (Number(t.cash_delta) || 0),
    0,
  )

  if (loading) {
    return (
      <div className="py-6 text-center text-sm text-[var(--text-muted)]">
        加载中…
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-center">
        <Stat label="运行中" value={String(running)} tone="info" />
        <Stat label="休市暂停" value={String(marketClosed)} tone="muted" />
        <Stat label="手动暂停" value={String(paused - marketClosed)} tone="warn" />
        <Stat
          label="累计现金盈亏"
          value={`${cashSum >= 0 ? "+" : ""}${cashSum.toFixed(0)}`}
          tone={cashSum >= 0 ? "up" : "down"}
        />
      </div>

      {tasks.length === 0 ? (
        <div className="py-4 text-center text-xs text-[var(--text-muted)]">
          暂无 AI 交易任务
          <button
            type="button"
            className="ml-2 text-[var(--accent-info)] hover:underline"
            onClick={() => router.push("/ai-trading")}
          >
            去创建 →
          </button>
        </div>
      ) : (
        <div className="space-y-1 max-h-48 overflow-y-auto">
          {tasks.slice(0, 8).map((task) => {
            const key = statusKey(task)
            const pnl = Number(task.position_unrealized ?? task.cash_delta ?? 0)
            return (
              <button
                key={task.id}
                type="button"
                onClick={() => router.push("/ai-trading")}
                className="w-full flex items-center justify-between py-1.5 px-2 rounded hover:bg-[var(--bg-tertiary)] text-left"
              >
                <div className="min-w-0 flex items-center gap-2">
                  <span className="text-sm text-[var(--text-primary)] truncate">
                    {task.name || task.symbol_name || task.symbol}
                  </span>
                  <Badge variant="outline" className="text-[10px] shrink-0">
                    {STATUS_LABEL[key] || task.status}
                  </Badge>
                  {task.status === "stopped" ? null : (
                    <span className="text-[10px] text-[var(--text-muted)] shrink-0">
                      {task.symbol} · {task.timeframe}
                    </span>
                  )}
                </div>
                <span
                  className={cn(
                    "font-num text-xs shrink-0",
                    pnl >= 0 ? "text-up" : "text-down",
                  )}
                >
                  {pnl >= 0 ? "+" : ""}
                  {pnl.toFixed(2)}
                </span>
              </button>
            )
          })}
          {stopped > 0 ? (
            <div className="text-[10px] text-[var(--text-muted)] px-2 pt-1">
              含已结束 {stopped} 个 · 共 {tasks.length} 个任务
            </div>
          ) : null}
        </div>
      )}
    </div>
  )
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string
  value: string
  tone: "info" | "muted" | "warn" | "up" | "down"
}): React.JSX.Element {
  const color =
    tone === "up"
      ? "text-up"
      : tone === "down"
        ? "text-down"
        : tone === "warn"
          ? "text-[var(--accent-warn)]"
          : tone === "info"
            ? "text-[var(--accent-info)]"
            : "text-[var(--text-secondary)]"
  return (
    <div className="rounded border border-[var(--border)] bg-[var(--bg-tertiary)] px-2 py-1.5">
      <div className="text-[10px] text-[var(--text-muted)]">{label}</div>
      <div className={cn("font-num text-sm font-semibold", color)}>{value}</div>
    </div>
  )
}
