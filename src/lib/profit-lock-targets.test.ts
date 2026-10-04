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
  it("marks saved enabled tasks as locked while distinguishing actual activation", () => {
    const config = { enabled: true, mode: "auto", unit: "percent", activation: 3, giveback: 1, cooldown_signals: 1 } as const
    const configured = task("configured", "running", { position_qty: 1, close_rules: { profit_lock: config } })
    const labels = profitLockTargets([
      configured,
      { ...configured, id: "active", profit_lock_state: { activated: true, locked_net: 8 } },
      { ...configured, id: "cooldown", position_qty: 0, profit_lock_state: { closed: true, cooldown_remaining: 2 } },
      { ...configured, id: "disabled", close_rules: { ...configured.close_rules, profit_lock: { ...config, enabled: false } } },
    ], []).map(t => t.label)
    expect(labels[0]).toContain("已锁利（等待激活）")
    expect(labels[1]).toContain("已锁利（已激活）")
    expect(labels[2]).toContain("已锁利（冷却 · 剩余 2 次信号）")
    expect(labels[3]).toContain("未开启锁利")
  })
  it("uses the saved hunter configuration and preserves pending exits even if disabled", () => {
    const config = { enabled: true, mode: "auto", unit: "percent", activation: 3, giveback: 1, cooldown_signals: 1 } as const
    const h = { ...group("running"), config: { ...group("running").config, profit_lock: config } }
    expect(profitLockTargets([], [h])[0].label).toContain("已锁利")
    expect(profitLockTargets([], [group("running")])[0].label).toContain("未开启锁利")
    expect(profitLockTargets([task("pending", "running", { profit_lock_state: { closing: true } })], [])[0].label).toContain("锁利平仓中")
  })
})
