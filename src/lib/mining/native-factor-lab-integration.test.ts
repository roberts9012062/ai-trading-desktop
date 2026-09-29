import { beforeEach, describe, expect, it, vi } from "vitest"
import type { EvalRequest, GenerationStep } from "./backends/types"
import { NativeRecoveryPaused } from "@/lib/native-engine/recovery"
const controlled = vi.hoisted(() => ({ create: vi.fn(), finalize: vi.fn(), requests: [] as EvalRequest[] }))
vi.mock("@/lib/local-factor", async () => {
  const actual = await vi.importActual<typeof import("@/lib/local-factor")>("@/lib/local-factor")
  return { ...actual, prepareSearchBars: async () => [{ time: "2025-01-01", close: 100 }, { time: "2025-01-02", close: 101 }],
    createSearchBackend: controlled.create, finalizeSearchResult: controlled.finalize }
})
vi.mock("@/lib/factor-lab-api", () => ({ saveFactorHistory: vi.fn(async () => {}) }))
const payload = { symbol: "ETHUSDT", timeframe: "15m", population: 10, generations: 3, top_n: 10, seed: 42, train_ratio: .7, walk_forward_folds: 3 }
const archive = [{ composite: 1, tokens: [0], metrics: { kernel_version: "native-gpu-v1", native_eval_precision: "f64" } }]
const value = (generation: number): GenerationStep => ({ generation, totalGenerations: 3, elapsedMs: 1,
  bestComposite: 1, champions: [], bestSeen: archive, engineTag: "native-gpu-v1", actualEngine: "native-gpu", nativeRestarts: 1 })
async function until(check: () => boolean) {
  for (let n = 0; n < 200; n++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)) }
  throw new Error("factor lab did not settle")
}
beforeEach(async () => {
  const { factorLabRunner } = await import("./factor-lab-runner")
  factorLabRunner.stop()
  controlled.create.mockReset(); controlled.requests.length = 0
  controlled.finalize.mockReset().mockResolvedValue({ champions: [], bars: 2, symbol: "ETHUSDT", timeframe: "15m", portfolio: null })
})
describe("factor lab native boundaries", () => {
  it("a pause during cold startup cannot become completed or reveal the sealed result", async () => {
    let proceed!: () => void
    const gate = new Promise<void>(resolve => { proceed = resolve })
    const dispose = vi.fn(async () => {})
    controlled.create.mockResolvedValue({ dispose, async *runDirect() { await gate; return [] } })
    const { factorLabRunner } = await import("./factor-lab-runner")
    const pending = factorLabRunner.start(payload, "native-gpu")
    await until(() => controlled.create.mock.calls.length > 0)
    factorLabRunner.pause(); proceed(); await pending
    expect(factorLabRunner.current?.status).toBe("paused")
    expect(controlled.finalize).not.toHaveBeenCalled()
    expect(dispose).toHaveBeenCalledTimes(1)
  })
  it("immediate resume waits for the active generation cleanup and uses the latest D-1 archive", async () => {
    let proceed!: () => void
    const gate = new Promise<void>(resolve => { proceed = resolve })
    let released = false
    controlled.create.mockImplementationOnce(async () => ({ dispose: async () => {},
      async *runDirect(_bars: unknown, req: EvalRequest) {
        controlled.requests.push(req)
        try { yield value(1); await gate; yield value(2); return [] }
        finally { released = true }
      } })).mockImplementationOnce(async () => {
        expect(released).toBe(true)
        return { dispose: async () => {}, async *runDirect(_bars: unknown, req: EvalRequest) {
          controlled.requests.push(req); yield value(3); return []
        } }
      })
    const { factorLabRunner } = await import("./factor-lab-runner")
    const first = factorLabRunner.start(payload, "native-gpu")
    await until(() => factorLabRunner.current?.generation === 1)
    factorLabRunner.pause()
    const resumed = factorLabRunner.resume()
    await Promise.resolve()
    expect(controlled.create).toHaveBeenCalledTimes(1)
    proceed(); await first; await resumed
    expect(controlled.requests[1]).toMatchObject({ startGeneration: 2, seedBest: archive, nativeRestarts: 1 })
    expect(factorLabRunner.current?.status).toBe("completed")
    expect(controlled.finalize).toHaveBeenCalledTimes(1)
    expect(controlled.finalize.mock.calls[0][3]).toBe("native-gpu")
  })
  it("an exhausted native process budget becomes recoverable paused in the lab", async () => {
    controlled.create.mockResolvedValue({ dispose: async () => {}, async *runDirect() { throw new NativeRecoveryPaused("budget exhausted", 3) } })
    const { factorLabRunner } = await import("./factor-lab-runner")
    await factorLabRunner.start(payload, "native-gpu")
    expect(factorLabRunner.current).toMatchObject({ status: "paused", nativeRestarts: 3, generation: 0, error: null })
  })
})
