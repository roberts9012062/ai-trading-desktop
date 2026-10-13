import type { AITradingTask } from "@/lib/ai-trading-api"

/** Execution status and exchange exposure are independent; never hide a residual. */
export function inactivePositionLabel(task: AITradingTask): string | null {
  const status = ({ paused: "已暂停", stopped: "已停止", failed: "运行失败", error: "运行异常" } as Record<string, string>)[task.status]
  if (!status) return null
  if (task.position_sync_status) return `${status} · 持仓待确认`
  if (task.has_open_position === true || (task.position_qty ?? 0) > 0) return `${status} · 仍有持仓`
  return null
}

export function TaskPositionActivity({ task }: { task: AITradingTask }) {
  const label = inactivePositionLabel(task)
  if (!label) return null
  return <div role="status" className="mt-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-[11px] text-amber-300">
    <p className="font-medium">{label}</p>
    {task.status === "paused" && task.pause_reason && <p className="mt-1 break-words">{task.pause_reason}</p>}
  </div>
}
