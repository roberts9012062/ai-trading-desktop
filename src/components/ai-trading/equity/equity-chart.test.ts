import { createElement } from "react"
import { renderToString } from "react-dom/server"
import { expect, it } from "vitest"
import { EquityChart } from "./equity-chart"
import { updateEquityTraces } from "./equity-wave-data"
import type { AITradingTask } from "@/lib/ai-trading-api"

it("renders observed position data consistently without deriving a day reset from the render clock", () => {
  const task = { id: "one", name: "模型 A", symbol: "btcusdt", timeframe: "5m", position_qty: 1, position_direction: "long", has_open_position: true, position_unrealized: -1.32, position_opened_at: "2026-10-04T04:00:00Z" } as AITradingTask
  const traces = updateEquityTraces({}, [task], Date.parse("2026-10-04T04:01:00Z"))
  const props = { tasks: [task], series: {}, traces }
  const markup = renderToString(createElement(EquityChart, props))
  expect(markup).toContain("贝塞尔持仓波段")
  expect(markup).toContain("data-sample-count=\"1\"")
  expect(markup).not.toContain("00:00→24:00")
  expect(renderToString(createElement(EquityChart, props))).toBe(markup)
  const closed = renderToString(createElement(EquityChart, { ...props, tasks: [{ ...task, position_qty: 0, position_direction: null, has_open_position: false }] }))
  expect(closed).toContain("暂无持仓收益轨迹")
  expect(closed).not.toContain("data-task-id=\"one\"")
})
