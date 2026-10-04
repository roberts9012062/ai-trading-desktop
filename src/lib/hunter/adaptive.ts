import { atr, ema, closedBars, findSignal, trend, type Bar, type Cycle, type Direction, type RuleVersion, type Signal } from "./rules"

export function marketAllows(rows: Bar[], cycle: Cycle, direction: Direction, weekly: Bar[] = [], version?: RuleVersion) {
  if (version !== "hunter-v3" || cycle !== "short") return trend(rows, cycle, direction, weekly)
  if (rows.length < 64) return false
  const values = rows.map(b => b[4]), f = ema(values, 20), s = ema(values, 60), a = atr(rows), n = rows.length-1, sign = direction === "long" ? 1 : -1
  if (a <= 0) return false
  const adverse = sign*(f[n]-s[n]) < -.5*a && sign*(f[n]-f[n-3]) < 0 && sign*(values[n]-s[n]) < 0
  return !adverse && sign*(values[n]-values[n-1]) >= -2*a
}

export function roomClear(setup: Bar[], before: number, entry: number, stop: number, direction: Direction) {
  const sign = direction === "long" ? 1 : -1, distance = Math.abs(entry-stop), history = setup.filter(b => b[0] < before).slice(-120)
  for (let k = 5; k < history.length-5; k++) {
    const v = history[k][direction === "long" ? 2 : 3], left = history.slice(k-5, k), right = history.slice(k+1, k+6)
    if (![...left, ...right].every(b => sign*(v-b[direction === "long" ? 2 : 3]) > 0)) continue
    const prominence = Math.min(...[left, right].map(side => direction === "long" ? v-Math.min(...side.map(b => b[3])) : Math.max(...side.map(b => b[2]))-v))
    const a = atr(history.slice(0, k+1))
    if (a > 0 && prominence >= 1.5*a && sign*(v-entry) > 0 && sign*(v-entry) < 2*distance) return false
  }
  return true
}

export function adaptiveEntry(setup: Bar[], execution: Bar[], direction: Direction, now: number): Signal | null {
  const sign = direction === "long" ? 1 : -1
  setup = closedBars(setup, 900, now); execution = closedBars(execution, 300, now)
  const signals: Signal[] = [], breakout = findSignal(setup, execution, "short", direction, now, "hunter-v3")
  if (breakout) signals.push({ ...breakout, entry_kind: "breakout" })
  if (execution.length >= 65) {
    const values = execution.map(b => b[4]), f = ema(values, 20), s = ema(values, 60)
    for (let k = execution.length-1; k > Math.max(63, execution.length-4); k--) {
      const b = execution[k], at = b[0]/1000+300
      if (at > now || now > at+240 || sign*(f[k]-s[k]) <= 0 || sign*(f[k]-f[k-3]) <= 0) continue
      for (let j = k-1; j > Math.max(59, k-4); j--) {
        const ret = execution[j], a = atr(execution.slice(0, j+1)), offset = sign*((direction === "long" ? ret[3] : ret[2])-f[j])
        const approach = execution.slice(j-4, j).some((x, n) => sign*(x[4]-f[j-4+n]) >= .5*a)
        if (a <= 0 || !approach || offset < -.5*a || offset > .25*a || sign*(ret[4]-f[j]) < 0) continue
        if (sign*(b[4]-(direction === "long" ? ret[2] : ret[3])) <= 0 || sign*(b[4]-b[1]) <= 0 || sign*(b[4]-f[k]) <= 0) continue
        const path = execution.slice(j, k+1), extreme = direction === "long" ? Math.min(...path.map(x => x[3])) : Math.max(...path.map(x => x[2]))
        const stop = direction === "long" ? Math.min(extreme-.25*a, b[4]-1.5*a) : Math.max(extreme+.25*a, b[4]+1.5*a)
        if (roomClear(setup, ret[0], b[4], stop, direction)) signals.push({ direction, entry: b[4], stop, breakout: f[j], atr: a, signal_at: at,
          expires_at: at+240, entry_kind: "pullback", reason: "自身趋势通过；重要阻力检查；EMA20回调收盘确认" })
      }
      const a = atr(execution.slice(0, k)), prior = execution.slice(k-6, k), level = direction === "long" ? Math.max(...prior.map(x => x[2])) : Math.min(...prior.map(x => x[3]))
      const average = execution.slice(k-20, k).reduce((total, x) => total+x[5], 0)/20
      if (a <= 0 || average <= 0 || sign*(b[4]-level) <= 0 || sign*(b[4]-b[1]) < .25*a || sign*(b[4]-f[k]) > 2*a || b[5] < 1.1*average) continue
      if (b[2]-b[3] > 3*a || sign*((direction === "long" ? b[2] : b[3])-b[4]) > .35*(b[2]-b[3])) continue
      const path = execution.slice(k-3, k+1), extreme = direction === "long" ? Math.min(...path.map(x => x[3])) : Math.max(...path.map(x => x[2]))
      const stop = direction === "long" ? Math.min(extreme-.25*a, b[4]-1.5*a) : Math.max(extreme+.25*a, b[4]+1.5*a)
      if (roomClear(setup, b[0], b[4], stop, direction)) signals.push({ direction, entry: b[4], stop, breakout: level, atr: a, signal_at: at,
        expires_at: at+240, entry_kind: "continuation", reason: "自身趋势通过；6根局部突破、量能与实体确认；限制追涨杀跌" })
    }
  }
  const priority = { breakout: 2, pullback: 1, continuation: 0 }
  return signals.sort((a, b) => b.signal_at-a.signal_at || priority[b.entry_kind!]-priority[a.entry_kind!])[0] ?? null
}
