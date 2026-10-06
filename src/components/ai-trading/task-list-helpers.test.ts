import { describe, expect, it } from "vitest"
import type { AITradingTask } from "@/lib/ai-trading-api"
import { taskPnlFromQuotes } from "./task-list-helpers"

const task = {
  symbol: "ETHUSDT", position_qty: 2, position_direction: "long",
  position_avg_price: 100, position_last_price: 101, position_unrealized: 2,
} as AITradingTask

describe("shared task floating PnL", () => {
  it("uses the normalized streaming quote before a task poll", () => {
    expect(taskPnlFromQuotes(task, { ethusdt: { last_price: 105 } }).pnl).toBe(10)
    expect(taskPnlFromQuotes(task, { ETHUSDT: { last_price: 99 } }).pnl).toBe(-2)
  })
  it("falls back to the task value without a quote", () => {
    expect(taskPnlFromQuotes(task, {}).pnl).toBe(2)
  })
  it("returns zero after closing even if a quote remains cached", () => {
    const closed = { ...task, position_qty: 0, position_direction: null, has_open_position: false }
    expect(taskPnlFromQuotes(closed, { ethusdt: { last_price: 105 } })).toMatchObject({ pnl: 0, hasPosition: false })
  })
})
