import type { AITradingTask, ProfitLockConfig } from "./ai-trading-api"
import type { Hunter } from "./hunter/api"
import { profitLockStatus } from "./profit-lock-status"

export interface ProfitLockTarget {
  key: string
  id: string
  kind: "task" | "hunter"
  label: string
  config?: ProfitLockConfig | null
}

function taskLockLabel(task: AITradingTask): string {
  const view = profitLockStatus(task)
  if (!task.close_rules?.profit_lock?.enabled) return view?.label ?? "未开启锁利"
  const phase = view?.label === "已锁利" ? "已激活" : view?.label.replace(/^锁利已开启 · |^锁利/, "")
  return phase ? `已锁利（${phase}）` : "已锁利"
}

/** Keep ended tasks out unless they still have a position to protect. */
export function profitLockTargets(tasks: AITradingTask[], groups: Hunter[]): ProfitLockTarget[] {
  const statusLabel = (status: string) => status === "running" ? "运行中" : status === "paused" ? "已暂停" : "有持仓"
  return [
    ...groups.filter(g => g.status !== "stopped").map(g => ({
      key: `hunter:${g.id}`, id: g.id, kind: "hunter" as const,
      label: `${g.config.profit_lock?.enabled ? "已锁利" : "未开启锁利"} · 多周期猎手 · ${g.name} · ${g.status === "stopping" ? "停止中" : statusLabel(g.status)}`,
      config: g.config.profit_lock,
    })),
    ...tasks.filter(t => t.status === "running" || t.status === "paused" || t.has_open_position || (t.position_qty ?? 0) > 0).map(t => ({
      key: `task:${t.id}`, id: t.id, kind: "task" as const,
      label: `${taskLockLabel(t)} · ${t.strategy_type === "multi_cycle_hunter" ? "猎手交易" : "任务"} · ${t.name} · ${t.symbol.toUpperCase()} · ${statusLabel(t.status)}`,
      config: t.close_rules?.profit_lock,
    })),
  ]
}
