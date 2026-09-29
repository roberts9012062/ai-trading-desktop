import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ComputeBackend, EvalRequest, GenerationStep } from "./backends/types"
import type { Champion } from "@/lib/factor-lab-api"
import { NativeRecoveryPaused } from "@/lib/native-engine/recovery"

const state = vi.hoisted(() => ({ records: new Map<string, unknown>(), requests: [] as EvalRequest[] }))
vi.mock("./local-store", async () => {
  const actual = await vi.importActual<typeof import("./local-store")>("./local-store")
  return { ...actual, listLocalTasks: async () => [...state.records.values()],
    putLocalTask: async (record: { id: string }) => { state.records.set(record.id, structuredClone(record)) } }
})
vi.mock("./data-source", () => ({ acquireBarsSnapshot: async () => ({ id: "snap", bars: [], count: 1000, from: "2025-01-01", to: "2025-02-01" }),
  reconcileSnapshotRefs: async () => {}, releaseBarsSnapshot: async () => {}, getBarsSnapshot: async () => null }))
vi.mock("./device", () => ({ resolveDevice: async () => ({ device: "gpu", degraded: false }) }))
const cfg = { symbol: "ETHUSDT", timeframe: "15m", population: 10, generations: 2, max_depth: 3, train_ratio: .7, walk_forward_folds: 2 }
const archive = [{ composite: 1, tokens: [0], metrics: { kernel_version: "native-gpu-v1", native_eval_precision: "f64" } }]
const progress: GenerationStep = { generation: 1, totalGenerations: 2, bestComposite: 1, champions: [], elapsedMs: 5,
  bestSeen: archive, actualEngine: "native-gpu", engineTag: "native-gpu-v1", engineVersion: "fixture", nativeRestarts: 2,
  qualificationCounts: { research: 1, qualified: 0, pending: 0, rejected: 1 } }
async function until(check: () => boolean | Promise<boolean>) {
  for (let n = 0; n < 200; n++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 5)) }
  throw new Error("runner did not settle")
}
beforeEach(() => { state.records.clear(); state.requests.length = 0 })
describe("super-factor native persistence", () => {
  it("keeps a training archive with zero champions and resumes D-1 with its origin and budget", async () => {
    const { LocalMiningRunner } = await import("./local-runner")
    let proceed!: () => void
    const gate = new Promise<void>(resolve => { proceed = resolve })
    let instance = 0
    const factory = vi.fn((_device: string): ComputeBackend => {
      const first = instance++ === 0
      return { device: "gpu", probe: async () => ({ available: true }), dispose: async () => {},
        async *run(req, signal) {
          state.requests.push(req)
          if (first) { yield progress; await gate; if (signal.aborted) return []; }
          else yield { ...progress, generation: 2 }
          return []
        } }
    })
    const runner = new LocalMiningRunner({ backendFactory: factory })
    const task = await runner.create(cfg, { device: "native-gpu" })
    await until(async () => (await runner.get(task.id))?.current_generation === 1)
    await runner.pause(task.id); proceed()
    await until(() => state.records.has(task.id))
    await runner.resume(task.id)
    await until(async () => (await runner.get(task.id))?.status === "completed")
    expect(factory.mock.calls[0][0]).toBe("native-gpu")
    expect(state.requests[1]).toMatchObject({ startGeneration: 1, seedBest: archive, nativeRestarts: 2, actualEngine: "native-gpu" })
    const final = await runner.get(task.id)
    expect(final).toMatchObject({ champions_count: 0, engineTag: "native-gpu-v1", effectiveDevice: "gpu" })
  })
  it("lands an exhausted process budget in recoverable paused even before generation one", async () => {
    const { LocalMiningRunner } = await import("./local-runner")
    const runner = new LocalMiningRunner({ backendFactory: () => ({ device: "gpu", probe: async () => ({ available: true }), dispose: async () => {},
      async *run(): AsyncGenerator<GenerationStep, Champion[], void> { throw new NativeRecoveryPaused("budget exhausted", 3) } }) })
    const task = await runner.create(cfg, { device: "native-gpu" })
    await until(async () => (await runner.get(task.id))?.status === "paused")
    expect(await runner.get(task.id)).toMatchObject({ status: "paused", nativeRestarts: 3, current_generation: 0 })
  })
})
