export type Cycle = "short" | "medium" | "long"
export type Direction = "long" | "short"
export type Bar = [number, number, number, number, number, number]
export const RULE_VERSION = "hunter-v1"
export const BALANCED_VERSION = "hunter-v2"
export const ADAPTIVE_VERSION = "hunter-v3"
export const SWING_VERSION = "hunter-v4"
export type RuleVersion = typeof RULE_VERSION | typeof BALANCED_VERSION | typeof ADAPTIVE_VERSION | typeof SWING_VERSION | "hunter-macd-ma20"
export type EntryKind = "breakout" | "pullback" | "continuation"
import { adaptiveEntry } from "./adaptive"
import { swingEntry } from "./swing"
export const CYCLES = {
  short: { label: "短线", setup: "15m", execution: "5m", trend: "1h", setupSec: 900, executionSec: 300, lookback: 20, volume: 1.5, wait: 12, atrMult: 1.5, maxStop: .03, risk: .002, target: 2, ttl: 60, maxHold: 43200, idle: 7200, trail: 2, budget: .25 },
  medium: { label: "中线", setup: "4h", execution: "1h", trend: "1d", setupSec: 14400, executionSec: 3600, lookback: 20, volume: 1.2, wait: 12, atrMult: 2, maxStop: .08, risk: .003, target: 3, ttl: 300, maxHold: 1814400, idle: 259200, trail: 2.5, budget: .35 },
  long: { label: "长线", setup: "1d", execution: "1d", trend: "1d", setupSec: 86400, executionSec: 86400, lookback: 55, volume: 1.2, wait: 10, atrMult: 2.5, maxStop: .15, risk: .003, target: 4, ttl: 1800, maxHold: 15552000, idle: 1728000, trail: 3, budget: .2 },
} as const

export function closedBars(rows: Bar[], seconds: number, now: number): Bar[] {
  const valid = rows.filter(b => b.length >= 6 && b.every(Number.isFinite) && b[0] / 1000 + seconds <= now && b[1] > 0 && b[3] > 0 && b[2] >= Math.max(b[1], b[4], b[3]) && b[3] <= Math.min(b[1], b[4]) && b[5] >= 0)
  return [...new Map(valid.map(b => [b[0], b])).values()].sort((a, b) => a[0] - b[0])
}
export function ema(values: number[], period: number): number[] {
  if (!values.length) return []
  const out = [values[0]], a = 2 / (period + 1)
  for (const v of values.slice(1)) out.push(v * a + out[out.length - 1] * (1 - a))
  return out
}
export function atr(bars: Bar[]): number {
  if (bars.length < 15) return 0
  const trs = bars.slice(1).map((b, i) => Math.max(b[2] - b[3], Math.abs(b[2] - bars[i][4]), Math.abs(b[3] - bars[i][4])))
  let a = trs.slice(0, 14).reduce((x, y) => x + y, 0) / 14
  for (const v of trs.slice(14)) a = (a * 13 + v) / 14
  return a
}
export function trend(bars: Bar[], cycle: Cycle, direction: Direction, weekly: Bar[] = []): boolean {
  const long = cycle === "long", slow = long ? 200 : 60, fast = long ? 50 : 20
  if (bars.length < slow + 4) return false
  const close = bars.map(b => b[4]), f = ema(close, fast), s = ema(close, slow), i = close.length - 1, sign = direction === "long" ? 1 : -1
  if (sign * (f[i] - s[i]) <= 0 || sign * (close[i] - s[i]) <= 0 || (!long && sign * (f[i] - f[i - 3]) <= 0)) return false
  if (long) {
    if (weekly.length < 25) return false
    const w = ema(weekly.map(b => b[4]), 20), n = w.length - 1
    return sign * (w[n] - w[n - 4]) > 0
  }
  return true
}
export function validateLeverage(leverage: number, stopRate?: number, cost = 0) {
  if (!Number.isInteger(leverage) || leverage < 1 || leverage > 50) throw new Error("杠杆必须为 1–50 倍整数")
  if (stopRate !== undefined && (stopRate + cost) * leverage >= .5) throw new Error("当前杠杆下止损及成本超过初始保证金的 50%，跳过机会")
}
export function sizePosition(equity: number, cycle: Cycle, entry: number, stop: number, cost: number, direction: Direction = "long", leverage = 1) {
  validateLeverage(leverage)
  const sign = direction === "long" ? 1 : -1, d = sign * (entry - stop) / entry, c = CYCLES[cycle]
  if (![equity, entry, stop, cost].every(Number.isFinite) || equity <= 0 || entry <= 0 || stop <= 0 || cost < 0 || d <= 0 || d > c.maxStop || cost > .2 * d) throw new Error("止损距离或成本不合格")
  validateLeverage(leverage, d, cost)
  const risk_budget = equity * c.risk, notional = Math.min(risk_budget / (d + cost), equity * .2)
  return { entry, stop, quantity: notional / entry, risk_budget, cost_rate: cost, distance: Math.abs(entry - stop), notional, leverage, margin: notional / leverage }
}
export interface Signal { direction: Direction; entry: number; stop: number; breakout: number; atr: number; signal_at: number; expires_at: number; reason: string; entry_kind?: EntryKind }
export function cycleRules(cycle: Cycle, version: RuleVersion = RULE_VERSION) {
  const c = CYCLES[cycle]
  return (version === BALANCED_VERSION || version === ADAPTIVE_VERSION || version === SWING_VERSION) && cycle === "short" ? { ...c, volume: 1.3, ttl: version === BALANCED_VERSION ? 180 : 240 } : c
}
export const rankFraction = (version: RuleVersion = RULE_VERSION, cycle: Cycle = "short") => (version === ADAPTIVE_VERSION || version === SWING_VERSION) && cycle === "short" ? .5 : version === BALANCED_VERSION || version === ADAPTIVE_VERSION || version === SWING_VERSION ? .3 : .2
export function findSignal(setup: Bar[], execution: Bar[], cycle: Cycle, direction: Direction, now: number, version: RuleVersion = RULE_VERSION): Signal | null {
  const c = cycleRules(cycle, version), sign = direction === "long" ? 1 : -1
  for (let i = setup.length - 1; i >= c.lookback && i >= setup.length - c.wait - 5; i--) {
    const b = setup[i], prev = setup.slice(i - c.lookback, i), p = direction === "long" ? Math.max(...prev.map(x => x[2])) : Math.min(...prev.map(x => x[3]))
    const avg = setup.slice(Math.max(0, i - 20), i).reduce((s, x) => s + x[5], 0) / 20, a = atr(setup.slice(0, i + 1))
    if (a <= 0 || avg <= 0 || sign * (b[4] - p) <= 0 || b[5] < avg * c.volume) continue
    const after = execution.filter(x => x[0] >= b[0] + c.setupSec * 1000).slice(0, c.wait)
    for (let j = 0; j < after.length; j++) {
      const ret = after[j], extreme = direction === "long" ? ret[3] : ret[2], offset = sign * (extreme - p)
      if (offset < -.5 * a || offset > .25 * a || sign * (ret[4] - p) < 0) continue
      for (const confirm of after.slice(j + 1, j + 4)) {
        if (sign * (confirm[4] - (direction === "long" ? ret[2] : ret[3])) <= 0) continue
        const signal_at = confirm[0] / 1000 + c.executionSec, expires_at = signal_at + c.ttl
        if (now < signal_at || now > expires_at) continue
        const path = after.filter(x => x[0] <= confirm[0]), l = direction === "long" ? Math.min(...path.map(x => x[3])) : Math.max(...path.map(x => x[2]))
        const stop = direction === "long" ? Math.min(l - .25 * a, confirm[4] - c.atrMult * a) : Math.max(l + .25 * a, confirm[4] + c.atrMult * a)
        const distance = Math.abs(confirm[4] - stop), target = confirm[4] + sign * c.target * distance
        const history = setup.slice(Math.max(0, i - 120), i)
        let blocked = false
        for (let k = 2; k < history.length - 2; k++) {
          const v = direction === "long" ? history[k][2] : history[k][3]
          const neighbours = [history[k - 2], history[k - 1], history[k + 1], history[k + 2]]
          const pivot = neighbours.every(x => direction === "long" ? v > x[2] : v < x[3])
          if (pivot && sign * (v - confirm[4]) > 0 && sign * (target - v) > 0) blocked = true
        }
        if (!blocked) return { direction, entry: confirm[4], stop, breakout: p, atr: a, signal_at, expires_at, reason: "趋势通过；放量突破、回踩、收盘确认" }
      }
    }
  }
  return null
}

function targetClear(setup: Bar[], before: number, entry: number, stop: number, cycle: Cycle, direction: Direction) {
  const sign = direction === "long" ? 1 : -1, target = entry + sign*CYCLES[cycle].target*Math.abs(entry-stop)
  const history = setup.filter(b => b[0] < before).slice(-120)
  for (let k = 2; k < history.length-2; k++) {
    const v = direction === "long" ? history[k][2] : history[k][3]
    const neighbours = [...history.slice(k-2, k), ...history.slice(k+1, k+3)]
    if (neighbours.every(x => direction === "long" ? v > x[2] : v < x[3]) && sign*(v-entry) > 0 && sign*(target-v) > 0) return false
  }
  return true
}

function pullbackSignal(setup: Bar[], execution: Bar[], cycle: Cycle, direction: Direction, now: number): Signal | null {
  const c = cycleRules(cycle, BALANCED_VERSION), sign = direction === "long" ? 1 : -1
  if (execution.length < 65) return null
  const f = ema(execution.map(b => b[4]), 20), s = ema(execution.map(b => b[4]), 60)
  for (let k = execution.length-1; k > Math.max(63, execution.length-4); k--) {
    const confirm = execution[k], at = confirm[0]/1000+c.executionSec
    if (at > now || now > at+c.ttl || sign*(f[k]-s[k]) <= 0 || sign*(f[k]-f[k-3]) <= 0) continue
    for (let j = k-1; j > Math.max(59, k-4); j--) {
      const ret = execution[j], a = atr(execution.slice(0, j+1)), offset = sign*((direction === "long" ? ret[3] : ret[2])-f[j])
      const approach = execution.slice(j-4, j).some((b, n) => sign*(b[4]-f[j-4+n]) >= .5*a)
      if (a <= 0 || !approach || offset < -.5*a || offset > .25*a || sign*(ret[4]-f[j]) < 0) continue
      if (sign*(confirm[4]-(direction === "long" ? ret[2] : ret[3])) <= 0 || sign*(confirm[4]-confirm[1]) <= 0 || sign*(confirm[4]-f[k]) <= 0) continue
      const path = execution.slice(j, k+1), extreme = direction === "long" ? Math.min(...path.map(b => b[3])) : Math.max(...path.map(b => b[2]))
      const stop = direction === "long" ? Math.min(extreme-.25*a, confirm[4]-c.atrMult*a) : Math.max(extreme+.25*a, confirm[4]+c.atrMult*a)
      if (targetClear(setup, ret[0], confirm[4], stop, cycle, direction)) return { direction, entry: confirm[4], stop, breakout: f[j], atr: a,
        signal_at: at, expires_at: at+c.ttl, entry_kind: "pullback", reason: "趋势通过；EMA20回调、企稳收盘确认" }
    }
  }
  return null
}

export function entrySignal(setup: Bar[], execution: Bar[], cycle: Cycle, direction: Direction, now: number, version: RuleVersion = RULE_VERSION): Signal | null {
  if (version === SWING_VERSION) return swingEntry(setup, execution, cycle, direction, now)
  if (version === ADAPTIVE_VERSION) return cycle === "short" ? adaptiveEntry(setup, execution, direction, now) : entrySignal(setup, execution, cycle, direction, now, BALANCED_VERSION)
  if (version !== BALANCED_VERSION) return findSignal(setup, execution, cycle, direction, now)
  const c = cycleRules(cycle, version)
  setup = closedBars(setup, c.setupSec, now); execution = closedBars(execution, c.executionSec, now)
  const breakout = findSignal(setup, execution, cycle, direction, now, version)
  if (breakout) breakout.entry_kind = "breakout"
  const pullback = pullbackSignal(setup, execution, cycle, direction, now)
  return !breakout ? pullback : !pullback || breakout.signal_at >= pullback.signal_at ? breakout : pullback
}

export function watchStage(setup: Bar[], execution: Bar[], cycle: Cycle, direction: Direction, now: number) {
  const c = cycleRules(cycle, BALANCED_VERSION), sign = direction === "long" ? 1 : -1
  for (let i = setup.length-1; i >= c.lookback && i >= setup.length-c.wait-5; i--) {
    const b = setup[i], prev = setup.slice(i-c.lookback, i), p = direction === "long" ? Math.max(...prev.map(x => x[2])) : Math.min(...prev.map(x => x[3]))
    const a = atr(setup.slice(0, i+1)), avg = setup.slice(i-20, i).reduce((v, x) => v+x[5], 0)/20
    const expires = b[0]/1000+c.setupSec+c.wait*c.executionSec+c.ttl
    if (expires < now || a <= 0 || avg <= 0 || sign*(b[4]-p) <= 0 || b[5] < avg*c.volume) continue
    const after = execution.filter(x => x[0] >= b[0]+c.setupSec*1000).slice(0, c.wait)
    const retest = after.some(x => { const d = sign*((direction === "long" ? x[3] : x[2])-p); return d >= -.5*a && d <= .25*a && sign*(x[4]-p) >= 0 })
    return { stage: retest ? "等待突破确认" : "等待突破回踩", expires }
  }
  return { stage: "趋势回调观察", expires: now+c.executionSec*3 }
}
