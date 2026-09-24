"use client"

/**
 * AI 看盘行情 —— 右下任务记录面板（替代行情页成交明细）
 *
 * 不显示实盘/手动交易，只展示选中任务的：交易记录 / 分析记录 / 运行日志
 * （组件复用 AI 交易详情抽屉的实现）。任务下单/平仓预警命中时自动刷新。
 */

import { useEffect, useMemo, useState } from "react"
import { Bell, RefreshCw } from "lucide-react"
import { cn } from "@/lib/utils"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { TradeList } from "@/components/ai-trading/detail/trade-list"
import { DecisionList } from "@/components/ai-trading/detail/decision-list"
import { RunLogList } from "@/components/ai-trading/detail/run-log-list"
import { useAiMarketStore } from "@/stores/ai-market"
import { TaskAlertSettingsDialog } from "./task-alert-settings-dialog"

const AUTO_REFRESH_MS = 15_000

export function TaskRecordsPanel(): React.JSX.Element {
  const tasks = useAiMarketStore((s) => s.tasks)
  const selectedTaskId = useAiMarketStore((s) => s.selectedTaskId)
  const recordsSeq = useAiMarketStore((s) => s.recordsSeq)
  const trades = useAiMarketStore((s) => s.trades)
  const decisions = useAiMarketStore((s) => s.decisions)
  const loading = useAiMarketStore((s) => s.recordsLoading)
  const loadRecords = useAiMarketStore((s) => s.loadRecords)

  const task = useMemo(
    () => tasks.find((t) => t.id === selectedTaskId) ?? null,
    [tasks, selectedTaskId]
  )
  const taskId = task?.id ?? ""
  const running = task?.status === "running"

  // 预警命中（recordsSeq 变化）立即刷新
  useEffect(() => {
    if (recordsSeq === 0) return
    void loadRecords()
  }, [recordsSeq, loadRecords])

  // 运行中任务定期刷新（后台也持续交易）
  useEffect(() => {
    if (!running || !taskId) return
    const timer = setInterval(() => void loadRecords(), AUTO_REFRESH_MS)
    return () => clearInterval(timer)
  }, [running, taskId, loadRecords])

  const [tab, setTab] = useState("trades")
  const [alertOpen, setAlertOpen] = useState(false)

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--bg-secondary)]">
      {/* 工具栏：预警设置（对应行情页成交列表的大单预警设置位）+ 刷新 */}
      <div className="flex shrink-0 items-center justify-between border-b border-[var(--border)] px-2 py-1">
        <span className="text-[12px] text-[var(--text-primary)] truncate">
          任务记录
          {task && (
            <span className="ml-1.5 text-[10px] text-[var(--text-muted)]">
              {task.name}
            </span>
          )}
        </span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setAlertOpen(true)}
            title="任务预警设置"
            className="p-1.5 rounded-md text-[var(--text-muted)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--primary)] transition-colors cursor-pointer"
          >
            <Bell className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={() => void loadRecords()}
            title="刷新"
            className="p-1.5 rounded-md text-[var(--text-muted)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)] transition-colors cursor-pointer"
          >
            <RefreshCw className={cn("w-3.5 h-3.5", loading && "animate-spin")} />
          </button>
        </div>
      </div>

      {!taskId ? (
        <p className="text-xs text-[var(--text-muted)] text-center py-8 flex-1">
          左侧选择一个任务查看记录
        </p>
      ) : (
        <Tabs
          value={tab}
          onValueChange={setTab}
          className="flex min-h-0 flex-1 flex-col"
        >
          <TabsList className="mx-2 mt-1 shrink-0">
            <TabsTrigger value="trades" className="text-xs">
              交易记录
            </TabsTrigger>
            <TabsTrigger value="decisions" className="text-xs">
              分析记录
            </TabsTrigger>
            <TabsTrigger value="logs" className="text-xs">
              运行日志
            </TabsTrigger>
          </TabsList>
          <TabsContent
            value="trades"
            className="mt-0 min-h-0 flex-1 overflow-y-auto"
          >
            <div className="px-2.5">
              <TradeList items={trades} loading={loading} showFee={false} showStatus={false} />
            </div>
          </TabsContent>
          <TabsContent
            value="decisions"
            className="mt-0 min-h-0 flex-1 overflow-y-auto"
          >
            <DecisionList items={decisions} loading={loading} />
          </TabsContent>
          <TabsContent
            value="logs"
            className="mt-0 min-h-0 flex-1 overflow-y-auto"
          >
            <RunLogList taskId={taskId} open={tab === "logs"} />
          </TabsContent>
        </Tabs>
      )}

      <TaskAlertSettingsDialog open={alertOpen} onOpenChange={setAlertOpen} />
    </div>
  )
}
