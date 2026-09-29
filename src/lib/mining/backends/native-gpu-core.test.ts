import { describe, expect, it, vi } from "vitest"
import { runNativeGpuSession, type NativeSessionClient } from "./native-gpu-core"
import type { NativeHello, NativePrecisePayload, NativePreciseResult } from "@/lib/native-engine/types"
import type { EvalRequest } from "./types"

const hello = { engine_version: "native-gpu-v1-fixture", precision: "mixed", sm_count: 20, vram_mb: 6000 } as NativeHello
const bars = Array.from({ length: 90 }, (_, i) => ({ time: new Date(Date.UTC(2025, 0, 1, i)).toISOString(), close: 100 + i }))
const request: EvalRequest = { snapshotId: "test", config: { symbol: "ETHUSDT", timeframe: "60m",
  crypto_profile: true, population: 30, generations: 3, max_depth: 3,
  train_ratio: .7, walk_forward_folds: 3, seed: 42, top_n: 2 }, startGeneration: 0 }

function fixture(qualified = true) {
  const candidate = { tokens: [0], text: "f0", composite: 1, metrics: { sortino: 1, ann_ret: .1,
    kernel_version: "native-gpu-v1", native_eval_precision: "f64", native_engine_version: hello.engine_version,
    native_strict_passed: qualified }, qualification: { status: qualified ? "qualified" : "rejected", reasons: qualified ? [] : ["wf_oos_evidence_missing"] } }
  const result = { champions: qualified ? [candidate] : [], research_candidates: [candidate],
    pending_candidates: [], rejected_candidates: qualified ? [] : [candidate],
    qualification_requirements: {}, best_seen: [{ tokens: [0], composite: 1, metrics: {
      sortino: 1, ann_ret: .1, kernel_version: "native-gpu-v1", native_eval_precision: "f64", native_engine_version: hello.engine_version } }] } as NativePreciseResult
  const client = {
    loadBars: vi.fn(async () => {}),
    mineFeatures: vi.fn(async () => ({ feature_names: ["a", "b"], active_feature_ids: [0, 1], train_len: 63,
      total_len: 90, periods: 8760, cost: .0003, features_source: "gpu-taichi" })),
    rankShards: vi.fn(async (_session: string, tokens: number[][]) => ({ ranked: tokens.map(tokens => ({ tokens, score: 9000 })) })),
    evalShards: vi.fn(async (_session: string, tokens: number[][]) => ({ evaluated: tokens.map(tokens => ({ tokens,
      composite: 1, metrics: { ...result.best_seen[0].metrics } })) })),
    strictEval: vi.fn(async (_session: string, tokens: number[][]) => ({ strict: tokens.map(tokens => ({ tokens, pass: true, cross_scores: {} })) })),
    precise: vi.fn(async (_session: string, _payload: NativePrecisePayload) => structuredClone(result)), disposeSession: vi.fn(async () => {}),
  } satisfies NativeSessionClient
  return { client, result }
}

describe("native GPU generation core", () => {
  it("publishes f64 authority only and reveals the sealed holdout solely in the final generation", async () => {
    const { client } = fixture()
    const steps = []
    const gen = runNativeGpuSession(client, hello, bars, request, new AbortController().signal)
    let end
    while (true) { const row = await gen.next(); if (row.done) { end = row.value; break }; steps.push(row.value) }
    expect(steps.map(s => s.generation)).toEqual([1, 2, 3])
    expect(steps.every(s => s.bestComposite === 1 && s.engineTag === "native-gpu-v1")).toBe(true)
    expect(end?.[0].composite).toBe(1)
    expect(client.precise.mock.calls.map(call => call[1].final_generation)).toEqual([false, false, true])
    expect(client.disposeSession).toHaveBeenCalledTimes(1)
  })

  it("keeps rejected research candidates out of champions while retaining the training archive for D-1", async () => {
    const { client } = fixture(false)
    const steps = []
    for await (const step of runNativeGpuSession(client, hello, bars, request, new AbortController().signal)) steps.push(step)
    expect(steps.every(s => s.champions.length === 0 && s.bestSeen.length === 1 && s.rejectedCandidates.length === 1)).toBe(true)
    expect(client.precise.mock.calls[1][1].best_seen).toHaveLength(1)
  })

  it("finishes the active generation when paused and never reveals its sealed holdout", async () => {
    const { client } = fixture()
    const controller = new AbortController()
    client.strictEval.mockImplementationOnce(async () => { controller.abort(); return { strict: [] } })
    const steps = []
    for await (const step of runNativeGpuSession(client, hello, bars, request, controller.signal)) steps.push(step)
    expect(steps).toHaveLength(1)
    expect(steps[0].generation).toBe(1)
    expect(client.precise.mock.calls[0][1].final_generation).toBe(false)
    expect(client.disposeSession).toHaveBeenCalledTimes(1)
  })

  it("releases the frozen session when numerical execution fails", async () => {
    const { client } = fixture()
    client.strictEval.mockRejectedValueOnce(new Error("CUDA lost"))
    await expect(runNativeGpuSession(client, hello, bars, request, new AbortController().signal).next()).rejects.toThrow("CUDA lost")
    expect(client.disposeSession).toHaveBeenCalledTimes(1)
  })

  it("rejects mismatched public versions and missing qualification even when a client is mocked", async () => {
    const { client, result } = fixture()
    result.champions[0].metrics.native_engine_version = "old"
    client.precise.mockResolvedValue(result)
    await expect(runNativeGpuSession(client, hello, bars, request, new AbortController().signal).next()).rejects.toThrow(/版本|合格/)
  })
})
