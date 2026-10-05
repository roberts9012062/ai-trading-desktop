import { expect, it } from "vitest"
import { calcChartPivotSignals, calcPivotSignals } from "./pivot-signals"
import historyCase from "./fixtures/pivot_history_window.json"
import type { KlineBar } from "@/types"

const options = { alternate: true, minAmplitudePct: 0, minAtrMult: 0, atrPeriod: 14, minRightLive: 2 }
function valley(right: number): KlineBar[] {
  return [...Array.from({ length: 7 }, (_, i) => 100 - i), ...Array.from({ length: right }, (_, i) => 95 + i)].map((p, i) => ({
    time: `t${i}`, open: p, high: p + 1, low: p - 1, close: p, volume: 1,
    is_closed: i < 6 + right,
  }))
}

it("does not turn the sixth forming right bar into formal confirmation", () => {
  const bars = valley(6)
  expect(calcPivotSignals(bars, 6, 6, options).at(-1)).toMatchObject({ side: "long", time: "t6", provisional: true })
  expect(calcPivotSignals(bars, 6, 6, { ...options, minRightLive: 6 })).toEqual([])
  bars.at(-1)!.is_closed = true
  expect(calcPivotSignals(bars, 6, 6, { ...options, minRightLive: 6 }).at(-1)).toMatchObject({ side: "long", provisional: false })
})

it("preserves intrabar P2 and withdraws it when the forming bar breaks the valley", () => {
  const bars = valley(2)
  expect(calcPivotSignals(bars, 6, 6, options).at(-1)?.provisional).toBe(true)
  bars.at(-1)!.low = 90
  expect(calcPivotSignals(bars, 6, 6, options)).toEqual([])
})

it("respects disabled alternation even with amplitude filtering", () => {
  const bars = [100, 101, 110, 108, 107, 108, 109, 108, 107].map((p, i) => ({ time: `t${i}`, open: p, high: p+1, low: p-1, close: p, volume: 1 }))
  expect(calcPivotSignals(bars, 1, 2, { ...options, alternate: false, minAmplitudePct: 20, minRightLive: 1 }).map((s) => s.time)).toEqual(["t2", "t6"])
})

it("loading older history cannot change current OKX trading arrows", () => {
  const bars = historyCase.bars as KlineBar[]
  const p = historyCase.params
  const f = { ...options, minAmplitudePct: p.min_amplitude_pct, minAtrMult: p.min_atr_mult }
  const recent = (signals: ReturnType<typeof calcPivotSignals>, length: number) => signals.filter((s) => s.index >= length - 1 - p.right - 1).map(({ time, side, provisional }) => ({ time, side, provisional }))
  expect(recent(calcPivotSignals(bars, 6, 6, f), 500)).toHaveLength(1) // original mismatch
  const canonical = recent(calcPivotSignals(bars.slice(-240), 6, 6, f), 240)
  expect(canonical).toEqual([])
  expect(recent(calcChartPivotSignals(bars, 6, 6, f), 500)).toEqual(canonical)
})
