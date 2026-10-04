import { describe, expect, it } from "vitest"
import { profitLockTargets } from "./profit-lock-targets"
import type { AITradingTask } from "./ai-trading-api"
import type { Hunter } from "./hunter/api"

describe("profit lock task selection", () => {
  const task = (id: string, status: string, extra = {}) => ({ id, status, name: id, symbol: "btcusdt", close_rules: {}, ...extra }) as AITradingTask
  const group = (status: string) => ({ id: "same", status, name: "猎手", config: {} }) as Hunter
  it("keeps running, paused and still-held tasks, excluding flat history", () => {
    const targets = profitLockTargets([
      task("running", "running"), task("paused", "paused"), task("flat", "stopped"),
      task("quantity", "stopped", { position_qty: 1 }), task("position", "stopped", { has_open_position: true }),
    ], [])
    expect(targets.map(t => t.id)).toEqual(["running", "paused", "quantity", "position"])
  })
  it("separates group and task identifiers and keeps stopping groups", () => {
    expect(profitLockTargets([task("same", "running")], [group("stopping")]).map(t => t.key)).toEqual(["hunter:same", "task:same"])
    expect(profitLockTargets([], [group("stopped")])).toEqual([])
  })
  it("refills the selected object's config without copying another target's settings", () => {
    const config = { enabled: true, mode: "manual", unit: "usdt", activation: 10, giveback: 2, cooldown_signals: 3 } as const
    const targets = profitLockTargets([task("configured", "running", { close_rules: { profit_lock: config } }), task("default", "running")], [])
    expect(targets[0].config).toEqual(config)
    expect(targets[1].config).toBeUndefined()
  })
})
