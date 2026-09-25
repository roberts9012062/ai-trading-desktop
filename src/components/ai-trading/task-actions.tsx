"use client"

import { Loader2, Pause, Pencil, Play, SlidersHorizontal, Square, Trash2, Zap } from "lucide-react"
import { useState } from "react"
import { Button } from "@/components/ui/button"
import type { AITradingTask } from "@/lib/ai-trading-api"
import { useAITradingStore } from "@/stores/ai-trading"
import { showAlert, showConfirm } from "@/stores/dialog"
import { useSessionStatus } from "@/hooks/use-session-status"

interface TaskActionsProps {
  task: AITradingTask
  compact?: boolean
  onEdit?: (task: AITradingTask) => void
  /** 无持仓时调整盈亏比例（运行中也允许） */
  onEditRules?: (task: AITradingTask) => void
}

/** 任务开始/暂停/结束/评估/修改 */
export function TaskActions({
  task,
  compact = false,
  onEdit,
  onEditRules,
}: TaskActionsProps): React.JSX.Element {
  const startTask = useAITradingStore((s) => s.startTask)
  const pauseTask = useAITradingStore((s) => s.pauseTask)
  const stopTask = useAITradingStore((s) => s.stopTask)
  const deleteTask = useAITradingStore((s) => s.deleteTask)
  const runOnce = useAITradingStore((s) => s.runOnce)
  const [busy, setBusy] = useState(false)
  // 交易时段判断：开始/暂停/评估等需要行情的操作停盘禁用；
  // 结束/删除/修改等管理操作停盘仍允许（结束任务后端已支持，平仓失败会返回原因）。
  const { isOpen } = useSessionStatus(task.symbol || "")
  const marketClosed = !isOpen

  /** 结束任务：停盘时提示平仓可能失败；点击后无论成败都给明确反馈 */
  async function handleStop(): Promise<void> {
    const ok = await showConfirm({
      title: "结束任务",
      description: marketClosed
        ? "当前为停盘期间，结束任务时平仓可能失败（持仓会保留，待开盘再处理）。确定结束任务？"
        : "结束任务后默认平掉该品种持仓。确定？结束后若无持仓可再修改配置。",
      variant: "destructive",
      confirmText: "结束",
    })
    if (!ok) return
    await run(async () => {
      const updated = await stopTask(task.id, true)
      // 后端平仓失败时 note 含"平仓失败"，据此给精准反馈
      const note = String(updated.note || "")
      if (note.includes("平仓失败")) {
        await showAlert({
          title: "平仓失败",
          description: `任务已结束，但平仓失败：${note}\n\n持仓已保留，请在开盘期间手动平仓后再删除任务。`,
          variant: "destructive",
        })
      } else {
        await showAlert({ title: "任务已结束", description: "持仓已平。" })
      }
    })
  }

  async function run(fn: () => Promise<void>): Promise<void> {
    setBusy(true)
    try {
      await fn()
    } catch (err) {
      await showAlert({
        title: "操作失败",
        description: err instanceof Error ? err.message : "操作失败",
        variant: "destructive",
      })
    } finally {
      setBusy(false)
    }
  }

  async function handleDelete(): Promise<void> {
    if (task.status !== "stopped") {
      const ok = await showConfirm({
        title: "删除任务",
        description: "是否先平仓并结束任务？平仓后方可删除。",
        variant: "destructive",
        confirmText: "平仓并删除",
      })
      if (!ok) return
      await stopTask(task.id, true)
    } else {
      const ok = await showConfirm({
        title: "删除任务",
        description: "永久删除该任务及其决策/权益记录？订单保留。",
        variant: "destructive",
        confirmText: "永久删除",
      })
      if (!ok) return
    }
    await deleteTask(task.id)
  }

  const size = compact ? "sm" : "default"
  const canEdit = Boolean(task.can_edit)
  // 无持仓即可调盈亏比例；完整「修改」可用时不重复展示（修改弹窗已含规则）
  const canEditRules = !canEdit && Boolean(task.can_edit_rules)

  return (
    <div
      className="flex items-center gap-1.5 flex-wrap"
      onClick={(e) => e.stopPropagation()}
    >
      {(task.status === "paused" ||
        (task.status === "stopped" && !task.has_open_position)) &&
        task.pause_reason !== "market_closed" && (
          <Button
            size={size}
            variant="default"
            disabled={busy || marketClosed}
            onClick={() => run(() => startTask(task.id))}
            title={marketClosed ? "停盘期间不可操作" : undefined}
          >
            {busy ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Play className="w-3.5 h-3.5" />
            )}
            {!compact && <span className="ml-1">开始</span>}
          </Button>
        )}
      {task.status === "running" && (
        <Button
          size={size}
          variant="secondary"
          disabled={busy || marketClosed}
          onClick={() => run(() => pauseTask(task.id))}
          title={marketClosed ? "停盘期间不可操作" : undefined}
        >
          {busy ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <Pause className="w-3.5 h-3.5" />
          )}
          {!compact && <span className="ml-1">暂停</span>}
        </Button>
      )}
      {task.status !== "stopped" && (
        <>
          <Button
            size={size}
            variant="outline"
            disabled={busy || marketClosed}
            onClick={() => run(() => runOnce(task.id))}
            title={marketClosed ? "停盘期间不可操作" : "立即评估一次"}
          >
            <Zap className="w-3.5 h-3.5" />
            {!compact && <span className="ml-1">评估</span>}
          </Button>
          <Button
            size={size}
            variant="destructive"
            disabled={busy}
            onClick={() => void handleStop()}
            title={
              marketClosed
                ? "结束任务（停盘期间平仓可能失败，持仓保留待开盘）"
                : "结束任务（平仓该品种持仓）"
            }
          >
            <Square className="w-3.5 h-3.5" />
            {!compact && <span className="ml-1">结束</span>}
          </Button>
        </>
      )}
      <Button
        size={size}
        variant="destructive"
        disabled={busy}
        onClick={() => void run(() => handleDelete())}
        title="删除任务（运行中先平仓结束）"
      >
        <Trash2 className="w-3.5 h-3.5" />
        {!compact && <span className="ml-1">删除</span>}
      </Button>
      {canEdit && onEdit && (
        <Button
          size={size}
          variant="outline"
          disabled={busy}
          onClick={() => onEdit(task)}
          title="修改任务配置"
        >
          <Pencil className="w-3.5 h-3.5" />
          {!compact && <span className="ml-1">修改</span>}
        </Button>
      )}
      {canEditRules && onEditRules && (
        <Button
          size={size}
          variant="outline"
          disabled={busy}
          onClick={() => onEditRules(task)}
          title="调整止盈/止损与兜底平仓参数（持仓中仅可改兜底，运行中下轮生效）"
        >
          <SlidersHorizontal className="w-3.5 h-3.5" />
          {!compact && <span className="ml-1">改比例</span>}
        </Button>
      )}
    </div>
  )
}
