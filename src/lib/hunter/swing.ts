import { CYCLES, atr, ema, closedBars, entrySignal, trend, type Bar, type Cycle, type Direction, type Signal } from "./rules"
import { adaptiveEntry } from "./adaptive"

export function directionQuality(rows: Bar[], cycle: Cycle, direction: Direction, weekly: Bar[] = []) {
  if (!trend(rows, cycle, direction, weekly)) return false
  const sign = direction === "long" ? 1 : -1, values = rows.map(b => b[4]), recent = values.slice(-20)
  const effort = recent.slice(1).reduce((sum, x, i) => sum+Math.abs(x-recent[i]), 0)
  const a = atr(rows), f = ema(values, cycle === "long" ? 50 : 20), s = ema(values, cycle === "long" ? 200 : 60), n = values.length-1
  if (a <= 0 || effort <= 0 || sign*(recent.at(-1)!-recent[0])/effort < .2 || sign*(f[n]-s[n]) < .25*a || sign*(f[n]-f[n-3]) < .1*a) return false
  if (cycle === "short") {
    const groups = new Map<number, Bar[]>()
    for (const b of rows) { const start = Math.floor(b[0]/14400000)*14400000; groups.set(start, [...(groups.get(start) ?? []), b]) }
    const macro: Bar[] = [...groups.entries()].sort((a, b) => a[0]-b[0]).filter(([start, b]) => b.length === 4 && b.every((x, i) => x[0] === start+i*3600000))
      .map(([start, b]) => [start, b[0][1], Math.max(...b.map(x => x[2])), Math.min(...b.map(x => x[3])), b[3][4], b.reduce((sum, x) => sum+x[5], 0)])
    if (macro.length < 64) return false
    const v = macro.map(b => b[4]), fast = ema(v, 20), slow = ema(v, 60), m = atr(macro), k = v.length-1
    if (m <= 0 || (sign*(fast[k]-slow[k]) < -.5*m && sign*(v[k]-slow[k]) < 0)) return false
  }
  return true
}

export function targetPrice(entry: number, stop: number, cost: number, direction: Direction, minimum = 3) {
  const sign = direction === "long" ? 1 : -1, distance = sign*(entry-stop)
  if (![entry, stop, cost, minimum].every(Number.isFinite) || Math.min(entry, stop) <= 0 || distance <= 0 || cost < 0 || cost >= .1 || minimum < 3) throw new Error("净盈亏比参数不合格")
  const target = entry+sign*(minimum*distance+(minimum+1)*entry*cost)/(1-sign*cost)
  if (target <= 0) throw new Error("净收益目标价格不合格")
  return target
}

export function netRR(entry: number, stop: number, target: number, cost: number, direction: Direction) {
  const sign = direction === "long" ? 1 : -1, risk = sign*(entry-stop)+entry*cost
  if (![entry, stop, target, cost].every(Number.isFinite) || Math.min(entry, stop, target) <= 0 || risk <= 0 || cost < 0) return -1
  return (sign*(target-entry)-target*cost)/risk
}

export function swingEntry(setup: Bar[], execution: Bar[], cycle: Cycle, direction: Direction, now: number): Signal | null {
  if (cycle === "short") {
    const signal = adaptiveEntry(setup, execution, direction, now)
    if (!signal) return null
    const sign = direction === "long" ? 1 : -1, ex = closedBars(execution, 300, now), st = closedBars(setup, 900, now)
    const candidates = [signal.stop, signal.entry-sign*2*atr(ex)]
    if (st.length >= 6) {
      const edge = direction === "long" ? Math.min(...st.slice(-6).map(b => b[3])) : Math.max(...st.slice(-6).map(b => b[2]))
      const structure = edge-sign*.25*atr(st), distance = sign*(signal.entry-structure)/signal.entry
      if (distance > 0 && distance <= CYCLES.short.maxStop) candidates.push(structure)
    }
    return { ...signal, stop: direction === "long" ? Math.min(...candidates) : Math.max(...candidates), reason: signal.reason+"；15m结构与2ATR缓冲，按固定资金风险缩小数量" }
  }
  const c = CYCLES[cycle], sign = direction === "long" ? 1 : -1
  setup = closedBars(setup, c.setupSec, now); execution = closedBars(execution, c.executionSec, now)
  const prior = entrySignal(setup, execution, cycle, direction, now, "hunter-v2"), signals: Signal[] = prior ? [prior] : []
  if (execution.length >= 65) {
    const values = execution.map(b => b[4]), f = ema(values, 20), s = ema(values, 60), n = execution.length-1
    const b = execution[n], at = b[0]/1000+c.executionSec, a = atr(execution.slice(0, -1)), prev = execution.slice(-7, -1)
    const level = direction === "long" ? Math.max(...prev.map(x => x[2])) : Math.min(...prev.map(x => x[3]))
    const avg = execution.slice(-21, -1).reduce((total, x) => total+x[5], 0)/20
    if (at <= now && now <= at+c.ttl && a > 0 && avg > 0 && sign*(f[n]-s[n]) > 0 && sign*(f[n]-f[n-3]) > 0
      && sign*(b[4]-level) > 0 && sign*(b[4]-b[1]) >= .25*a && sign*(b[4]-f[n]) > 0 && sign*(b[4]-f[n]) <= 2*a
      && b[5] >= 1.1*avg && b[2]-b[3] <= 3*a && sign*((direction === "long" ? b[2] : b[3])-b[4]) <= .35*(b[2]-b[3])) {
      const extreme = direction === "long" ? Math.min(...execution.slice(-4).map(x => x[3])) : Math.max(...execution.slice(-4).map(x => x[2]))
      const stop = direction === "long" ? Math.min(extreme-.25*a, b[4]-c.atrMult*a) : Math.max(extreme+.25*a, b[4]+c.atrMult*a)
      signals.push({ direction, entry: b[4], stop, breakout: level, atr: a, signal_at: at, expires_at: at+c.ttl,
        entry_kind: "continuation", reason: "高周期趋势通过；局部延续、量能与实体收盘确认；待净3:1空间复核" })
    }
  }
  return signals.sort((a, b) => b.signal_at-a.signal_at)[0] ?? null
}
