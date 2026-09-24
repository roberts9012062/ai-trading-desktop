"use client"

/**
 * 任务预警右下角弹窗（transient，不入库）
 *
 * 任务下单/平仓成交时由 WS task_order_tick 事件触发（仅本人任务），
 * 右下角堆叠显示 10 秒自动消失：开多红 / 开空绿 / 平仓橙。
 */

import { useEffect } from "react"
import { X, TrendingUp, TrendingDown, MinusCircle } from "lucide-react"
import { cn } from "@/lib/utils"
import { useTaskAlertToastStore, type TaskAlertToast } from "@/stores/task-alert-toast"
import { paperActionLabel } from "@/lib/trade-labels"
import { contractName } from "@/lib/contract-names"
import { useAiMarketStore } from "@/stores/ai-market"

const AUTO_DISMISS_MS = 10_000

/** 单条任务预警卡片 */
function ToastCard({
  toast,
  taskName,
  onDismiss,
}: {
  toast: TaskAlertToast
  taskName: string | null
  onDismiss: (id: number) => void
}): React.JSX.Element {
  useEffect(() => {
    const timer = setTimeout(() => onDismiss(toast.id), AUTO_DISMISS_MS)
    return () => clearTimeout(timer)
  }, [toast.id, onDismiss])

  const isClose = toast.offset === "close"
  const Icon = isClose ? MinusCircle : toast.direction === "buy" ? TrendingUp : TrendingDown
  const action = paperActionLabel(toast.direction, toast.offset)

  return (
    <div
      role="alert"
      aria-live="assertive"
      className={cn(
        "w-80 max-w-[calc(100vw-3rem)] rounded-lg border shadow-2xl",
        "bg-[var(--bg-secondary)] transition-all duration-300 ease-out",
        "animate-[fadeIn_0.3s_ease-in]",
      )}
      style={{ borderColor: toast.color }}
    >
      <div className="p-3 space-y-1.5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            <Icon className="h-3.5 w-3.5" style={{ color: toast.color }} />
            <span className="text-xs font-bold" style={{ color: toast.color }}>
              任务预警
            </span>
          </div>
          <button
            type="button"
            onClick={() => onDismiss(toast.id)}
            className="p-1 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors cursor-pointer"
            aria-label="关闭"
          >
            <X size={14} />
          </button>
        </div>
        <p className="text-sm font-bold text-[var(--text-primary)] truncate">
          {taskName || toast.taskId.slice(0, 8)}
        </p>
        <p className="text-xs text-[var(--text-secondary)]">
          {contractName(toast.symbol)}
          <span className="ml-2 font-bold" style={{ color: toast.color }}>
            {action}
          </span>
          <span className="font-num font-bold ml-1" style={{ color: toast.color }}>
            {toast.qty}
          </span>
          手
          {toast.price != null && (
            <span className="ml-2 text-[var(--text-muted)]">
              @ {toast.price}
            </span>
          )}
        </p>
      </div>
    </div>
  )
}

export function TaskAlertToastPopup(): React.JSX.Element {
  const toasts = useTaskAlertToastStore((s) => s.toasts)
  const dismiss = useTaskAlertToastStore((s) => s.dismiss)
  const tasks = useAiMarketStore((s) => s.tasks)

  if (toasts.length === 0) return <></>

  // 与 MessagePopup / 大单弹窗错开：再上移一层堆叠
  return (
    <div className="fixed right-6 bottom-[24.5rem] z-50 flex flex-col gap-2 items-end">
      {toasts.map((t) => (
        <ToastCard
          key={t.id}
          toast={t}
          taskName={tasks.find((x) => x.id === t.taskId)?.name ?? null}
          onDismiss={dismiss}
        />
      ))}
    </div>
  )
}
