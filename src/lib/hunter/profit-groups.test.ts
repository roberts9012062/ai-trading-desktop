import { expect, it } from "vitest"
import { groupHunterRows } from "./profit-groups"
import type { AITradingTask } from "../ai-trading-api"
import type { Hunter } from "./api"
const groups = [{ id: "hunter-one", name: "猎手一", opportunities: [{ task_id: "recent" }] }, { id: "hunter-two", name: "猎手二", opportunities: [] }] as unknown as Hunter[]
const tasks = [{ id: "older-than-100", strategy_params: {hunter_id: "hunter-one"} }, { id: "other", strategy_params: {hunter_id: "hunter-two"} }] as unknown as AITradingTask[]
it("folds all owned child tasks, including older trades absent from the recent opportunities, without mixing hunters", () => {
  const rows = [{taskId: "normal", value: 4}, {taskId: "recent", value: 5}, {taskId: "older-than-100", value: -2}, {taskId: "other", value: 9}]
  const result = groupHunterRows(rows, tasks, groups)
  expect(result.map(g => [g.id, g.children.map(c => c.taskId)])).toEqual([["normal", ["normal"]], ["hunter:hunter-one", ["recent", "older-than-100"]], ["hunter:hunter-two", ["other"]]])
  expect(result.flatMap(g => g.children).reduce((sum, row) => sum + row.value, 0)).toBe(16)
})
it("keeps unmatched tasks independent rather than guessing a hunter from the task name", () => {
  const rows = [{taskId: "unknown", value: 10}]
  expect(groupHunterRows(rows, [], groups)[0].hunter).toBeUndefined()
})
