import { createElement } from "react"
import { renderToString } from "react-dom/server"
import { expect, it } from "vitest"
import { ProfitBarChart } from "./profit-bar-chart"
import { HunterProfitSummary } from "@/components/hunter/hunter-profit-summary"
import type { Hunter } from "@/lib/hunter/api"
import type { ProfitCloseBar, AITradingTask } from "@/lib/ai-trading-api"

it("renders one initially collapsed hunter total and keeps its original task profits inside the group", () => {
  const items = [{ task_id: "a", task_name: "币 A", realized: 4, unrealized: 1, total_pnl: 5 }, { task_id: "b", task_name: "币 B", realized: -1, unrealized: -1, total_pnl: -2 }, { task_id: "normal", task_name: "普通任务", realized: 4, unrealized: 0, total_pnl: 4 }] as unknown as ProfitCloseBar[]
  const hunters = [{ id: "hunter", name: "测试猎手", opportunities: [{task_id: "a"}] }] as unknown as Hunter[]
  const tasks = [{ id: "b", strategy_params: {hunter_id: "hunter"} }] as unknown as AITradingTask[]
  const html = renderToString(createElement(ProfitBarChart, { items, hunters, tasks, totalRealized: 7, totalUnrealized: 0, totalPnl: 7, openPositionCount: 2, loading: false }))
  const summaries = [...html.matchAll(/<summary[^>]*>([\s\S]*?)<\/summary>/g)]
  expect(summaries).toHaveLength(1)
  expect(summaries[0][1]).toContain("+3.00")
  expect(summaries[0][1]).not.toContain("币 A")
  expect(html).toContain("币 A"); expect(html).toContain("币 B"); expect(html).toContain("普通任务")
  expect(html).not.toMatch(/<details[^>]*\bopen(?:=|>)/)
})
it("uses server all-history hunter totals rather than the limited recent opportunity list", () => {
  const hunter = { runtime: {realized: 100, unrealized: -5}, capital: 1000, stats: {trades: 200}, opportunities: [{finished_at: null, net_profit: 1}] } as unknown as Hunter
  const html = renderToString(createElement(HunterProfitSummary, {hunter}))
  expect(html).toContain("+95.00")
  expect(html).toContain("9.50")
})
it("uses the net hunter ledger for the bar and header when stale child bars omit costs", () => {
  const items = [{task_id:"aave",task_name:"AAVE",realized:-8.856,unrealized:0,total_pnl:-8.856},
    {task_id:"xau",task_name:"XAU",realized:1.096,unrealized:0,total_pnl:1.096}] as unknown as ProfitCloseBar[]
  const hunter = {id:"hunter",name:"AI 多周期猎手",status:"running",runtime:{realized:-9.3710856,unrealized:0},
    opportunities:[{task_id:"aave",finished_at:"closed"},{task_id:"xau",finished_at:"closed"}]} as unknown as Hunter
  const html = renderToString(createElement(ProfitBarChart,{items,hunters:[hunter],tasks:[],totalRealized:-7.76,totalUnrealized:0,totalPnl:-7.76,openPositionCount:0,loading:false}))
  const summary = html.match(/<summary[^>]*>([\s\S]*?)<\/summary>/)?.[1]
  expect(summary).toContain("-9.37")
  expect(html.match(/-9\.37/g)?.length).toBeGreaterThanOrEqual(3)
})
