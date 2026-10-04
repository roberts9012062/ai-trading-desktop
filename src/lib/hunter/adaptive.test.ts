import { expect, it } from "vitest"
import { entrySignal, type Bar, type RuleVersion } from "./rules"

const version = "hunter-v3" as RuleVersion
it.each(["long", "short"] as const)("matches server adaptive minor pivot golden for %s", direction => {
  let setup: Bar[] = Array.from({ length: 26 }, (_, i) => [i*900000, 100, 100.5, 99.5, 100, 100])
  let execution: Bar[] = Array.from({ length: 80 }, (_, i) => [i*300000, 100+i*.1-.02, 100+i*.1+.12, 100+i*.1-.12, 100+i*.1, 100])
  execution[78] = [23400000, 107.8, 107.9, 106.7, 107, 100]
  execution[79] = [23700000, 107, 108.5, 106.95, 108.3, 100]
  for (let i = 10; i <= 20; i++) setup[i] = [i*900000, 108.6, 108.9, 108.4, 108.6, 100]
  setup[15][2] = 109
  if (direction === "short") {
    const mirror = (rows: Bar[]): Bar[] => rows.map(b => [b[0], 220-b[1], 220-b[3], 220-b[2], 220-b[4], b[5]])
    setup = mirror(setup); execution = mirror(execution)
  }
  expect(entrySignal(setup, execution, "short", direction, 24010, "hunter-v2")).toBeNull()
  const signal = entrySignal(setup, execution, "short", direction, 24010, version)
  expect(signal?.entry_kind).toBe("pullback")
  expect(signal?.entry).toBeCloseTo(direction === "long" ? 108.3 : 111.7)
  expect(signal?.expires_at).toBe(24240)
})

it("requires fresh closed continuation with volume, no chase and retained risk limits", () => {
  const setup: Bar[] = Array.from({ length: 26 }, (_, i) => [i*900000, 100, 100.3, 99.7, 100, 100])
  const execution: Bar[] = Array.from({ length: 80 }, (_, i) => [i*300000, 100+i*.02, 100+i*.02+.3, 100+i*.02-.3, 100+i*.02, 100])
  execution[79] = [23700000, 101.4, 102.3, 101.35, 102.2, 130]
  expect(entrySignal(setup, execution, "short", "long", 24002, version)?.entry_kind).toBe("continuation")
  expect(entrySignal(setup, execution, "short", "long", 23999, version)).toBeNull()
  expect(entrySignal(setup, execution, "short", "long", 24241, version)).toBeNull()
  execution[79][5] = 80
  expect(entrySignal(setup, execution, "short", "long", 24002, version)).toBeNull()
})
