import { renderToStaticMarkup } from "react-dom/server"
import { createElement } from "react"
import { describe, expect, it } from "vitest"
import type { AITradingTask } from "@/lib/ai-trading-api"
import { TaskCloseButton } from "./task-close-button"

const task = { status: "running", position_qty: 1 } as AITradingTask
const render = (value: AITradingTask, busy = false) => renderToStaticMarkup(createElement(TaskCloseButton, { task: value, busy, onClose: () => {} }))
describe("manual close card button", () => {
  it.each(["ai", "decision", "factor", "shortline_factor", "multi_cycle_hunter", "swing_pivot"])("shows a named close button for %s without auto lock", strategy_type => {
    const html = render({ ...task, strategy_type })
    expect(html).toContain('aria-label="一键平仓"')
    expect(html).not.toContain('disabled=""')
    expect(html).toContain("冷却 1 次有效开仓信号")
  })
  it("disables empty positions, requests and pending confirmations", () => {
    expect(render({ ...task, position_qty: 0 })).toContain('disabled=""')
    expect(render(task, true)).toContain('disabled=""')
    const pending = render({ ...task, profit_lock_state: { closing: true } })
    expect(pending).toContain('disabled=""')
    expect(pending).toContain("平仓中…")
  })
  it("still allows held paused/stopped tasks and uses the configured cooldown", () => {
    expect(render({ ...task, status: "paused" })).not.toContain('disabled=""')
    expect(render({ ...task, status: "stopped" })).not.toContain('disabled=""')
    expect(render({ ...task, close_rules: { profit_lock: { cooldown_signals: 3 } } } as AITradingTask)).toContain("冷却 3 次有效开仓信号")
  })
})
