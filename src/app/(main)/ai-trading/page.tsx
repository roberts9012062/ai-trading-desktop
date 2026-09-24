"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { Award, LineChart, Plus, RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { CreateTaskDialog } from "@/components/ai-trading/form/create-task-dialog"
import { CreateQuantDialog } from "@/components/ai-trading/form/create-quant-dialog"
import { EditTaskDialog } from "@/components/ai-trading/form/edit-task-dialog"
import { EditRulesDialog } from "@/components/ai-trading/form/edit-rules-dialog"
import { EquityChart } from "@/components/ai-trading/equity/equity-chart"
import { ProfitBarChart } from "@/components/ai-trading/profit/profit-bar-chart"
import { TaskDetailDrawer } from "@/components/ai-trading/detail/task-detail-drawer"
import { TaskFavoriteDialog } from "@/components/ai-trading/task-favorite-dialog"
import { CreateFromFavoriteDialog } from "@/components/ai-trading/create-from-favorite-dialog"
import {
  listTaskFavorites,
  type TaskFavoriteItem,
} from "@/lib/strategy-favorites-api"
import { TaskList } from "@/components/ai-trading/task-list"
import type { AITradingTask } from "@/lib/ai-trading-api"
import { useAITradingStore } from "@/stores/ai-trading"
import { useMarketStore } from "@/stores/market"

/** AI 交易主页面 */
export default function AITradingPage(): React.JSX.Element {
  const tasks = useAITradingStore((s) => s.tasks)
  const equitySeries = useAITradingStore((s) => s.equitySeries)
  const profitBars = useAITradingStore((s) => s.profitBars)
  const profitTotalRealized = useAITradingStore((s) => s.profitTotalRealized)
  const profitTotalUnrealized = useAITradingStore((s) => s.profitTotalUnrealized)
  const profitTotalPnl = useAITradingStore((s) => s.profitTotalPnl)
  const profitOpenCount = useAITradingStore((s) => s.profitOpenCount)
  const profitLoading = useAITradingStore((s) => s.profitLoading)
  const loading = useAITradingStore((s) => s.loading)
  const error = useAITradingStore((s) => s.error)
  const selectedTaskId = useAITradingStore((s) => s.selectedTaskId)
  const decisions = useAITradingStore((s) => s.decisions)
  const trades = useAITradingStore((s) => s.trades)
  const detailLoading = useAITradingStore((s) => s.detailLoading)
  const loadTasks = useAITradingStore((s) => s.loadTasks)
  const loadEquity = useAITradingStore((s) => s.loadEquity)
  const loadProfitBars = useAITradingStore((s) => s.loadProfitBars)
  const selectTask = useAITradingStore((s) => s.selectTask)
  const initWebSocket = useMarketStore((s) => s.initWebSocket)

  const loadTaskFavs = useCallback(async () => {
    try {
      setTaskFavs(await listTaskFavorites())
    } catch {
      setTaskFavs([])
    }
  }, [])

  const [createOpen, setCreateOpen] = useState(false)
  const [quantOpen, setQuantOpen] = useState(false)
  // 任务收藏：星标弹窗 + 创建优秀任务
  const [favTask, setFavTask] = useState<AITradingTask | null>(null)
  const [fromFavOpen, setFromFavOpen] = useState(false)
  const [taskFavs, setTaskFavs] = useState<TaskFavoriteItem[]>([])
  const [editTask, setEditTask] = useState<AITradingTask | null>(null)
  const [editRulesTask, setEditRulesTask] = useState<AITradingTask | null>(null)

  // 行情 WS：任务浮盈用最新价每秒重算
  useEffect(() => {
    initWebSocket()
  }, [initWebSocket])

  useEffect(() => {
    void loadTaskFavs()
  }, [loadTaskFavs])

  useEffect(() => {
    void loadTasks().then(() => {
      void loadEquity()
      void loadProfitBars()
    })
  }, [loadTasks, loadEquity, loadProfitBars])

  // 运行中/有仓：1s 刷任务与总收益柱（含浮盈），5s 刷曲线
  useEffect(() => {
    const hasRunning = tasks.some((t) => t.status === "running")
    const hasOpenPos = tasks.some(
      (t) => (t.position_qty ?? 0) > 0 || t.has_open_position,
    )
    if (!hasRunning && !hasOpenPos) return
    const taskTimer = setInterval(() => {
      void loadTasks({ silent: true })
    }, 1000)
    const profitTimer = setInterval(() => {
      void loadProfitBars({ silent: true })
    }, 1000)
    const equityTimer = setInterval(() => {
      void loadEquity()
    }, 5000)
    return () => {
      clearInterval(taskTimer)
      clearInterval(profitTimer)
      clearInterval(equityTimer)
    }
  }, [tasks, loadTasks, loadEquity, loadProfitBars])

  const selectedTask = useMemo(
    () => tasks.find((t) => t.id === selectedTaskId) ?? null,
    [tasks, selectedTaskId],
  )

  const runningCount = tasks.filter((t) => t.status === "running").length

  return (
    <div className="h-full overflow-y-auto p-4 md:p-6 space-y-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-lg font-semibold text-[var(--text-primary)]">
            AI 交易
          </h1>
          <p className="text-xs text-[var(--text-muted)] mt-1">
            AI / 量化 · 运行 {runningCount} 个 · 浮盈按品种实时价（不含手续费）
            · 休市自动暂停，开盘自动恢复
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              void loadTasks().then(() => {
                void loadEquity()
                void loadProfitBars()
              })
            }}
            disabled={loading}
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
            刷新
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setFromFavOpen(true)}
          >
            <Award className="w-3.5 h-3.5" />
            创建优秀任务
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setQuantOpen(true)}
          >
            <LineChart className="w-3.5 h-3.5" />
            创建量化交易
          </Button>
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus className="w-3.5 h-3.5" />
            创建 AI 交易
          </Button>
        </div>
      </div>

      {error && (
        <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-md px-3 py-2">
          {error}
        </div>
      )}

      <EquityChart tasks={tasks} series={equitySeries} profitBars={profitBars} />

      <ProfitBarChart
        items={profitBars}
        totalRealized={profitTotalRealized}
        totalUnrealized={profitTotalUnrealized}
        totalPnl={profitTotalPnl}
        openPositionCount={profitOpenCount}
        loading={profitLoading}
      />

      <div>
        <h2 className="text-sm font-medium text-[var(--text-secondary)] mb-2">
          任务列表
        </h2>
        <TaskList
          tasks={tasks}
          selectedId={selectedTaskId}
          onSelect={(id) => {
            void selectTask(id)
          }}
          onEdit={(t) => setEditTask(t)}
          onEditRules={(t) => setEditRulesTask(t)}
          favoritedIds={
            new Set(taskFavs.map((f) => f.task_id).filter(Boolean) as string[])
          }
          onFavorite={(t) => setFavTask(t)}
        />
      </div>

      <CreateTaskDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
      />

      <CreateQuantDialog
        open={quantOpen}
        onClose={() => setQuantOpen(false)}
      />

      <EditTaskDialog
        open={Boolean(editTask)}
        task={editTask}
        onClose={() => setEditTask(null)}
      />

      <EditRulesDialog
        open={Boolean(editRulesTask)}
        task={editRulesTask}
        onClose={() => setEditRulesTask(null)}
      />

      <TaskFavoriteDialog
        task={favTask ? { id: favTask.id, name: favTask.name } : null}
        currentFolderId={
          taskFavs.find((f) => f.task_id === favTask?.id)?.folder_id ?? null
        }
        onClose={() => setFavTask(null)}
        onSaved={() => void loadTaskFavs()}
      />

      <CreateFromFavoriteDialog
        open={fromFavOpen}
        onClose={() => {
          setFromFavOpen(false)
          void loadTasks()
        }}
      />

      <TaskDetailDrawer
        open={Boolean(selectedTaskId)}
        task={selectedTask}
        decisions={decisions}
        trades={trades}
        loading={detailLoading}
        onClose={() => {
          void selectTask(null)
        }}
        onEdit={(t) => {
          void selectTask(null)
          setEditTask(t)
        }}
        onEditRules={(t) => {
          void selectTask(null)
          setEditRulesTask(t)
        }}
      />
    </div>
  )
}
