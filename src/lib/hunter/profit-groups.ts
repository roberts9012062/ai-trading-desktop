import type { AITradingTask } from "../ai-trading-api"
import type { Hunter } from "./api"
export interface HunterRowGroup<T> { id: string; hunter?: Hunter; children: T[] }

export function groupHunterRows<T extends { taskId: string }>(rows: T[], tasks: AITradingTask[], hunters: Hunter[]): HunterRowGroup<T>[] {
  const owners = new Map<string, string>()
  const byId = new Map(hunters.map(h => [h.id, h]))
  for (const hunter of hunters) for (const opportunity of hunter.opportunities) {
    if (opportunity.task_id) owners.set(opportunity.task_id, hunter.id)
  }
  // Task metadata covers older trades outside the API's most recent 100 opportunities.
  for (const task of tasks) {
    const params = task.strategy_params as Record<string, unknown> | undefined
    if (typeof params?.hunter_id === "string" && byId.has(params.hunter_id)) owners.set(task.id, params.hunter_id)
  }
  const grouped = new Map<string, HunterRowGroup<T>>()
  for (const row of rows) {
    const hunter = byId.get(owners.get(row.taskId) ?? "")
    const id = hunter ? "hunter:" + hunter.id : row.taskId
    let group = grouped.get(id)
    if (!group) { group = { id, hunter, children: [] }; grouped.set(id, group) }
    group.children.push(row)
  }
  return [...grouped.values()]
}
