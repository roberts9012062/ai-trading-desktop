import { expect, it } from "vitest"
import { calcPivotSignals } from "./pivot-signals"
import fixture from "./fixtures/dot60_okx_swap_2026-10-05.json"

it("reproduces the DOT 08:00 venue mismatch and agrees with server OKX pivots", () => {
  const p = fixture.params
  const options = { alternate: true, minAmplitudePct: p.min_amplitude_pct, minAtrMult: p.min_atr_mult, atrPeriod: p.atr_period, minRightLive: p.min_right_live }
  for (const source of ["okx_swap", "binance_spot"] as const) {
    const signals = calcPivotSignals(fixture[source], p.left, p.right, options)
    expect(signals.slice(-3)).toEqual(fixture.expected[source])
  }
  expect(fixture.expected.binance_spot.at(-1)?.time).toBe("2026-10-05 08:00:00")
  expect(fixture.expected.binance_spot.at(-1)?.side).toBe("long")
  expect(fixture.expected.okx_swap.at(-1)?.side).toBe("short")
})
