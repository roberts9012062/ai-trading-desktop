import type { AITradingTask } from "../ai-trading-api"
import type { Hunter, Opportunity } from "./api"
export function activeHunterChild(task: AITradingTask): boolean {
  return (task.position_qty ?? 0) > 0 || task.has_open_position === true || !["stopped", "failed", "error"].includes(task.status)
}
export function visibleHunterOpportunities(ops: Opportunity[], tasks: AITradingTask[]): Opportunity[] {
  const byId = new Map(tasks.map(task => [task.id, task]))
  return ops.filter(op => !op.finished_at || (op.task_id && byId.has(op.task_id) && ((byId.get(op.task_id)!.position_qty ?? 0) > 0 || byId.get(op.task_id)!.has_open_position === true)))
}
export function hunterNeedsTaskPoll(groups: Hunter[]): boolean {
  return groups.some(group => group.status === "running" || group.opportunities.some(op => !op.finished_at))
}
/** The ranking lists the same active children as the hunter panel, even before
 * a fill or first waveform sample. Curves still require observed positions. */
export function comparisonTasks(tasks: AITradingTask[], hunters: Hunter[]): AITradingTask[] {
  const active = new Set(hunters.flatMap(h => visibleHunterOpportunities(h.opportunities, tasks).flatMap(o => o.task_id ? [o.task_id] : [])))
  return tasks.filter(t => active.has(t.id) || t.position_sync_status || t.has_open_position === true || (t.position_qty ?? 0) > 0)
}
export function visibleHunterChildren<T extends {taskId: string; hasOpen?: boolean}>(rows: T[], tasks: AITradingTask[], hunter: Hunter): T[] {
  const byId = new Map(tasks.map(task => [task.id, task]))
  const ops = new Map(hunter.opportunities.map(op => [op.task_id, op]))
  return rows.filter(row => row.hasOpen || (byId.has(row.taskId) ? activeHunterChild(byId.get(row.taskId)!) : !ops.get(row.taskId)?.finished_at))
}
