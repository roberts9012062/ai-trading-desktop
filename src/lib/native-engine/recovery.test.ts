import { describe, expect, it, vi } from "vitest"
import type { Champion } from "@/lib/factor-lab-api"
import type { EvalRequest, GenerationStep } from "@/lib/mining/backends/types"
import { NativeEngineError } from "./ipc"
import { runNativeRecovery, type DirectBackend, type NativeActualEngine } from "./recovery"

const req: EvalRequest = { snapshotId: "test", startGeneration: 0, config: { symbol: "ETHUSDT", timeframe: "15m",
  population: 10, generations: 3, max_depth: 3, train_ratio: .7, walk_forward_folds: 0 } }
const row = { tokens: [0], text: "test", composite: 1, metrics: { sortino: 1, ann_ret: .1,
  kernel_version: "native-gpu-v1", test_metrics: { sortino: 1 } } } as Champion
function step(generation: number): GenerationStep {
  return { generation, totalGenerations: 3, bestComposite: 1, champions: [], elapsedMs: 1,
    engineTag: "native-gpu-v1", engineVersion: "fixture", bestSeen: [{ ...row, metrics: row.metrics as unknown as Record<string, unknown> }] }
}
describe("native D-1 recovery and fallback", () => {
  it("retries from the last full generation using its training archive even when champions are empty", async () => {
    const requests: EvalRequest[] = [], dispose = vi.fn(async () => {})
    let count = 0
    const create = async (): Promise<DirectBackend> => {
      const index = count++
      return { dispose, async *runDirect(_bars, request) {
        requests.push(request)
        if (index === 0) { yield step(1); throw new NativeEngineError("killed", "DISCONNECTED") }
        yield step(2); yield step(3); return []
      } }
    }
    const recovery = vi.fn()
    const gen = runNativeRecovery([], req, new AbortController().signal, create, recovery)
    const generations: number[] = []
    for await (const value of gen) generations.push(value.generation)
    expect(generations).toEqual([1, 2, 3])
    expect(requests[1].startGeneration).toBe(1)
    expect(requests[1].seedBest?.[0].tokens).toEqual([0])
    expect(recovery.mock.calls[0][0]).toMatchObject({ restarts: 1, engine: "native-gpu" })
    expect(dispose).toHaveBeenCalledTimes(2)
  })
  it("pauses after exactly three automatic retries and preserves the per-task budget", async () => {
    const recovery = vi.fn(), create = vi.fn(async (): Promise<DirectBackend> => ({ dispose: async () => {},
      async *runDirect() { throw new NativeEngineError("killed", "DISCONNECTED"); return [] } }))
    await expect(runNativeRecovery([], req, new AbortController().signal, create, recovery).next())
      .rejects.toMatchObject({ code: "RECOVERY_EXHAUSTED", restarts: 3 })
    expect(create).toHaveBeenCalledTimes(4)
    expect(recovery).toHaveBeenCalledTimes(3)
    create.mockClear()
    await expect(runNativeRecovery([], { ...req, nativeRestarts: 3 }, new AbortController().signal, create).next())
      .rejects.toMatchObject({ code: "RECOVERY_EXHAUSTED" })
    expect(create).toHaveBeenCalledTimes(1)
  })
  it.each(["STARTUP_UNAVAILABLE", "DRIVER_UNAVAILABLE", "SELF_CHECK_FAILED"])("%s follows native/WebGPU/CPU and never transfers native scores", async code => {
    const engines: NativeActualEngine[] = [], requests: EvalRequest[] = []
    const create = async (engine: NativeActualEngine): Promise<DirectBackend> => {
      engines.push(engine)
      return { dispose: async () => {}, async *runDirect(_bars, request) {
        requests.push(request)
        if (engine === "native-gpu") throw new NativeEngineError("unavailable", code)
        if (engine === "gpu") throw new Error("WebGPU absent")
        yield { ...step(1), champions: [{ ...row, metrics: { ...row.metrics, kernel_version: "cpu-version" } }] }
        return []
      } }
    }
    const gen = runNativeRecovery(Array(1000).fill({}), { ...req, seedBest: [{ ...row, metrics: row.metrics as unknown as Record<string, unknown> }] }, new AbortController().signal, create)
    const value = (await gen.next()).value as GenerationStep
    expect(engines).toEqual(["native-gpu", "gpu", "cpu"])
    expect(requests[1].seedBest).toEqual([])
    expect(requests[1].config.seed_tokens).toEqual([[0]])
    expect(value.actualEngine).toBe("cpu")
    expect(value.champions[0].metrics.kernel_version).toBe("cpu-version")
    await gen.return([])
  })
  it("rejects a failed fallback champion without affecting its training seeds", async () => {
    const create = async (engine: NativeActualEngine): Promise<DirectBackend> => ({ dispose: async () => {}, async *runDirect() {
      if (engine === "native-gpu") throw new NativeEngineError("no card", "CUDA_UNAVAILABLE")
      yield { ...step(1), champions: [{ ...row, metrics: { ...row.metrics, test_metrics: { sortino: -1 } as never } }] }
      return []
    } })
    const gen = runNativeRecovery(Array(1000).fill({}), req, new AbortController().signal, create)
    const value = (await gen.next()).value as GenerationStep
    expect(value.champions).toEqual([])
    expect(value.bestSeen).toHaveLength(1)
    expect(value.qualificationCounts?.rejected).toBe(1)
    await gen.return([])
  })
  it("does not consume retry budget or enter fallback after a manual pause", async () => {
    const controller = new AbortController(), recover = vi.fn()
    const create = vi.fn(async (): Promise<DirectBackend> => ({ dispose: async () => {}, async *runDirect() {
      yield step(1); throw new NativeEngineError("closed", "DISCONNECTED")
    } }))
    const gen = runNativeRecovery([], req, controller.signal, create, recover)
    await gen.next(); controller.abort()
    expect((await gen.next()).done).toBe(true)
    expect(recover).not.toHaveBeenCalled()
    expect(create).toHaveBeenCalledTimes(1)
  })
})
