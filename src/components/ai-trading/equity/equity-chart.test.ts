import { createElement } from "react"
import { renderToString } from "react-dom/server"
import { expect, it, vi } from "vitest"
import { EquityChart } from "./equity-chart"
import { updateEquityTraces } from "./equity-wave-data"
import type { AITradingTask } from "@/lib/ai-trading-api"
import { TaskList } from "../task-list"
import type { Hunter } from "@/lib/hunter/api"

const market = vi.hoisted(() => ({ quotes: {} as Record<string, { last_price: number }> }))
vi.mock("@/stores/market", () => ({
  useMarketStore: (selector: (state: typeof market) => unknown) => selector(market),
}))

it("renders observed position data consistently without deriving a day reset from the render clock", () => {
  const task = { id: "one", name: "模型 A", symbol: "btcusdt", timeframe: "5m", position_qty: 1, position_direction: "long", has_open_position: true, position_unrealized: -1.32, position_opened_at: "2026-10-04T04:00:00Z" } as AITradingTask
  const traces = updateEquityTraces({}, [task], Date.parse("2026-10-04T04:01:00Z"))
  const props = { tasks: [task], series: {}, traces }
  const markup = renderToString(createElement(EquityChart, props))
  expect(markup).toContain("贝塞尔持仓波段")
  expect(markup).toContain("data-sample-count=\"0\"")
  expect(markup).toContain("00:00→24:00")
  expect(markup).toContain("24:00")
  expect(renderToString(createElement(EquityChart, props))).toBe(markup)
  const closed = renderToString(createElement(EquityChart, { ...props, tasks: [{ ...task, position_qty: 0, position_direction: null, has_open_position: false }] }))
  expect(closed).toContain("暂无持仓收益轨迹")
  expect(closed).not.toContain("data-task-id=\"one\"")
})

it("updates floating cards and the leader from the same quotes as task cards before another poll", () => {
  const tasks = [
    { id: "long", name: "LongTask", symbol: "ethusdt", position_qty: 2, position_direction: "long", position_avg_price: 100, position_last_price: 101, position_unrealized: 2 },
    { id: "short", name: "ShortTask", symbol: "btcusdt", position_qty: 3, position_direction: "short", position_avg_price: 100, position_last_price: 99, position_unrealized: 3 },
  ].map(t => ({ ...t, timeframe: "5m", status: "running", strategy_type: "ma_cross", has_open_position: true, position_opened_at: "2026-10-04T04:00:00Z" })) as AITradingTask[]
  const traces = updateEquityTraces({}, tasks, Date.parse("2026-10-04T04:01:00Z"))
  const render = () => ({
    chart: renderToString(createElement(EquityChart, { tasks, series: {}, traces })),
    list: renderToString(createElement(TaskList, { tasks, selectedId: null, onSelect: () => {} })),
  })
  market.quotes = { ethusdt: { last_price: 102 }, btcusdt: { last_price: 98 } }
  const first = render()
  for (const html of Object.values(first)) {
    expect(html).toContain("+4.00")
    expect(html).toContain("+6.00")
  }
  expect(first.chart.indexOf("ShortTask")).toBeLessThan(first.chart.indexOf("LongTask"))
  market.quotes = { ethusdt: { last_price: 105 }, btcusdt: { last_price: 103 } }
  const next = render()
  for (const html of Object.values(next)) {
    expect(html).toContain("+10.00")
    expect(html).toContain("-9.00")
  }
  expect(next.chart.indexOf("LongTask")).toBeLessThan(next.chart.indexOf("ShortTask"))
  // Quote updates affect display only; historical observations remain authoritative.
  expect(traces.long.samples.at(-1)?.value).toBe(2)
  expect(traces.short.samples.at(-1)?.value).toBe(3)
  market.quotes = {}
})

it("lists all three active hunter children without requiring fills or curve samples", () => {
  const tasks = [
    { id: "filled", name: "已成交", symbol: "bzusdt", position_qty: 9.6, position_direction: "short", position_unrealized: 2 },
    { id: "reconcile", name: "XRP待对账", symbol: "xrpusdt", position_qty: 0, position_sync_status: "reconciling" },
    { id: "pending", name: "待成交单", symbol: "avaxusdt", position_qty: 0 },
    { id: "finished", name: "结束单", symbol: "minausdt", position_qty: 0, status: "stopped" },
  ].map(t => ({ timeframe: "60m", status: "running", strategy_type: "multi_cycle_hunter", ...t })) as AITradingTask[]
  const hunter = { id: "h", name: "枢轴猎手", status: "running", runtime: {}, opportunities: tasks.map(t => ({ task_id: t.id, finished_at: t.id === "finished" ? "2026-10-08" : null })) } as Hunter
  const html = renderToString(createElement(EquityChart, { tasks, series: {}, traces: {}, hunters: [hunter] }))
  expect(html).toContain("3 个运行子任务")
  for (const name of ["已成交", "XRP待对账", "待成交单", "持仓待对账", "等待成交"]) expect(html).toContain(name)
  expect(html).not.toContain("结束单")
  expect(html).not.toContain('data-task-id="pending"')
  expect(html).not.toContain('data-task-id="reconcile"')
})

it("keeps observations through an unknown snapshot without sampling a false zero", () => {
  const task = { id: "held", name: "Held", symbol: "xrpusdt", timeframe: "60m", position_qty: 698, position_direction: "long", position_unrealized: 4, has_open_position: true } as AITradingTask
  const traces = updateEquityTraces({}, [task], Date.now())
  const unresolved = { ...task, position_qty: 0, position_direction: null, has_open_position: false, position_sync_status: "reconciling" as const }
  const next = updateEquityTraces(traces, [unresolved], Date.now()+1000)
  expect(next.held).toBe(traces.held)
  const html=renderToString(createElement(EquityChart, { tasks: [unresolved], series: {}, traces: next }))
  expect(html).toContain("持仓待对账")
  expect(html).toContain('data-task-id="held"')
  expect(html).not.toContain("浮盈领先")
})
