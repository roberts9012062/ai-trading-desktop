import { describe, expect, it, vi } from "vitest"
import { NativeGpuBackend } from "./native-gpu-backend"
import type { EvalRequest } from "./types"
import type { NativeHello, NativePrecisePayload, NativePreciseResult } from "@/lib/native-engine/types"

vi.mock("../data-source", () => ({ getBarsSnapshot: vi.fn(async () => null) }))

const request: EvalRequest = { snapshotId: "missing", config: { symbol: "ETHUSDT", timeframe: "60m",
  population: 10, generations: 1, max_depth: 3, train_ratio: .7, walk_forward_folds: 3 }, startGeneration: 0 }
const endpoint = { port: 12345, pid: 9, token: "a".repeat(32) }

function fixture() {
  const hello = { engine_version: "native-gpu-v1-fixture", precision: "mixed", sm_count: 20, vram_mb: 6000 } as NativeHello
  const empty: NativePreciseResult = { champions: [], best_seen: [], research_candidates: [],
    pending_candidates: [], rejected_candidates: [], qualification_requirements: {} }
  const client = {
    connect: vi.fn(async () => hello), close: vi.fn(), loadBars: vi.fn(async () => {}),
    mineFeatures: vi.fn(async () => ({ feature_names: ["a"], active_feature_ids: [0], train_len: 2,
      total_len: 2, periods: 8760, cost: .0003, features_source: "gpu-taichi" })),
    rankShards: vi.fn(async () => ({ ranked: [] })), evalShards: vi.fn(async () => ({ evaluated: [] })),
    strictEval: vi.fn(async () => ({ strict: [] })),
    precise: vi.fn(async (_session: string, _payload: NativePrecisePayload) => empty),
    disposeSession: vi.fn(async () => {}),
  }
  const launch = vi.fn(async () => endpoint)
  const backend = new NativeGpuBackend({ createClient: () => client, launch })
  return { client, launch, backend, hello }
}

describe("native GPU backend connection ownership", () => {
  it("rejects missing snapshots before launching a process", async () => {
    const { backend, launch } = fixture()
    await expect(backend.run(request, new AbortController().signal).next()).rejects.toThrow(/快照/)
    expect(launch).not.toHaveBeenCalled()
  })

  it("does not connect a cancelled caller after the shared process finishes starting", async () => {
    const { client } = fixture()
    const controller = new AbortController()
    const launch = vi.fn(async () => { controller.abort(); return endpoint })
    const backend = new NativeGpuBackend({ createClient: () => client, launch })
    expect(await backend.runDirect([], request, controller.signal).next()).toEqual({ done: true, value: [] })
    expect(client.connect).not.toHaveBeenCalled()
    expect(client.close).toHaveBeenCalledTimes(1)
    // The injected launcher accepts only precision; no shared-process abort/kill.
    expect(launch.mock.calls[0]).toEqual([{ precision: "mixed" }])
  })

  it("closes its owned connection when launch fails", async () => {
    const { client } = fixture()
    const backend = new NativeGpuBackend({ createClient: () => client, launch: async () => { throw new Error("driver missing") } })
    await expect(backend.runDirect([], request, new AbortController().signal).next()).rejects.toThrow("driver missing")
    expect(client.close).toHaveBeenCalledTimes(1)
  })

  it("rejects a precision mismatch before loading the task", async () => {
    const { client, launch } = fixture()
    const backend = new NativeGpuBackend({ precision: "f64", createClient: () => client, launch })
    await expect(backend.runDirect([], request, new AbortController().signal).next()).rejects.toThrow(/精度/)
    expect(client.loadBars).not.toHaveBeenCalled()
    expect(client.close).toHaveBeenCalledTimes(1)
  })

  it("executes the direct entrance and releases session and connection on generator return", async () => {
    const { client, backend } = fixture()
    const bars = [{ time: "2025-01-01T00:00:00Z", close: 100 }, { time: "2025-01-01T01:00:00Z", close: 101 }]
    const gen = backend.runDirect(bars, request, new AbortController().signal)
    expect((await gen.next()).done).toBe(false)
    await gen.return([])
    expect(client.disposeSession).toHaveBeenCalledTimes(1)
    expect(client.close).toHaveBeenCalledTimes(1)
  })

  it("dispose closes a generator suspended at a generation boundary and releases its session", async () => {
    const { client, backend } = fixture()
    const bars = [{ time: "2025-01-01T00:00:00Z", close: 100 }, { time: "2025-01-01T01:00:00Z", close: 101 }]
    const gen = backend.runDirect(bars, request, new AbortController().signal)
    await gen.next()
    try {
      await backend.dispose()
      expect(client.disposeSession).toHaveBeenCalledTimes(1)
      expect((await gen.next()).done).toBe(true)
      expect(client.close).toHaveBeenCalledTimes(1)
    } finally { await gen.return([]) }
  })
})
