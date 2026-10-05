import { describe, expect, it } from "vitest"
import type { AITradingTask } from "./ai-trading-api"
import { profitLockStatus } from "./profit-lock-status"

const base = { status: "running", position_qty: 1, close_rules: { profit_lock: { enabled: true, mode: "auto", unit: "percent", activation: 3, giveback: 1, cooldown_signals: 1 } } } as AITradingTask
describe("server profit lock card status", () => {
  it("shows a signal invalidation exit separately from manual profit cooldown", () => {
    const task = { ...base, strategy_type: "swing_pivot", close_rules: {}, profit_lock_state: { signal_exit: true, closing: true } } as AITradingTask
    expect(profitLockStatus(task)?.label).toBe("信号失效平仓中")
    expect(profitLockStatus({ ...task, position_qty: 0, profit_lock_state: { signal_exit: true, closed: true, cooldown_remaining: 0 } })?.detail).toContain("新的枢轴")
    expect(profitLockStatus({ ...task, profit_lock_state: { signal_exit: true, error: "剩余持仓等待对账" } })).toMatchObject({ label: "信号失效止损等待处理", tone: "warning" })
  })
  it("shows manual cooldown even while automatic profit lock is disabled", () => {
    const task = { ...base, position_qty: 0, close_rules: { profit_lock: null }, profit_lock_state: { manual_exit: true, closed: true, cooldown_remaining: 2 } } as AITradingTask
    expect(profitLockStatus(task)?.label).toBe("锁利冷却 · 剩余 2 次信号")
    expect(profitLockStatus(task)?.detail).toContain("一键平仓")
    expect(profitLockStatus({ ...task, profit_lock_state: { ...task.profit_lock_state, cooldown_remaining: 0 } })).toBeNull()
  })
  it("shows the actual money floor, margin percent and net profit, updating on server snapshots", () => {
    const task = { ...base, profit_lock_state: { activated: true, locked_net: 7.7549, locked_pct: 7.7455, net_profit: 9 } }
    expect(profitLockStatus(task)).toMatchObject({ label: "已锁利", tone: "active" })
    expect(profitLockStatus(task)?.detail).toContain("7.75 USDT（保证金收益 7.75%）")
    expect(profitLockStatus({ ...task, profit_lock_state: { ...task.profit_lock_state, locked_net: 9 } })?.detail).toContain("9.00 USDT")
  })
  it("does not confuse enabling auto with activation or use its legacy activation field", () => {
    expect(profitLockStatus(base)?.label).toContain("等待激活")
    expect(profitLockStatus(base)?.detail).toContain("5.00%")
  })
  it("never shows a finished round as the current active floor", () => {
    const task = { ...base, position_qty: 0, profit_lock_state: { activated: false, closed: true, locked_net: 7.75, cooldown_remaining: 1 } }
    expect(profitLockStatus(task)?.label).toContain("锁利冷却")
    expect(profitLockStatus(task)?.detail).toContain("上轮锁利线")
    expect(profitLockStatus({ ...base, profit_lock_state: { activated: true, closed: true, locked_net: 7.75 } })?.label).not.toBe("已锁利")
  })
  it("prioritizes pending exits, audit errors and pauses over a stale active badge", () => {
    const state = { activated: true, locked_net: 8 }
    expect(profitLockStatus({ ...base, profit_lock_state: { ...state, error: "等待对账" } })?.tone).toBe("warning")
    expect(profitLockStatus({ ...base, status: "paused", profit_lock_state: state })?.label).toContain("暂停")
    expect(profitLockStatus({ ...base, status: "stopped", profit_lock_state: state })?.tone).toBe("warning")
    expect(profitLockStatus({ ...base, close_rules: { ...base.close_rules, profit_lock: null } })).toBeNull()
    expect(profitLockStatus({ ...base, close_rules: { ...base.close_rules, profit_lock: null }, profit_lock_state: { closing: true } })?.label).toBe("锁利平仓中")
  })
  it("does not render missing or non-finite floors as an active protection line", () => {
    for (const value of [undefined, NaN, Infinity, -1]) expect(profitLockStatus({ ...base, profit_lock_state: { activated: true, locked_net: value } })?.label).not.toBe("已锁利")
  })
})
