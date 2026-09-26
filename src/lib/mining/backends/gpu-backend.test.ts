/**
 * GpuBackend 编排单测(M4)——mock WebGPU 驱动与 Pyodide worker:
 * - 分代循环:粗排 → top-K 精算 → yield(粗排数字只用于排序);
 * - 种子/断点:startGeneration 跳代、seedBest 先精算注入;
 * - abort 在代边界返回;掉设备抛错(交由 local-runner 转 paused);
 * - finally 释放设备与批缓冲。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ensurePyWorker } from "@/lib/py-worker"
import { getBarsSnapshot } from "@/lib/mining/data-source"
import { acquireGpuDevice } from "@/lib/mining/device"
import { createGpuEval, disposeGpuEval, gpuEvalBatch } from "@/lib/mining/gpu/eval-gpu"
import type { Champion } from "@/lib/factor-lab-api"

vi.mock("@/lib/py-worker", () => ({ ensurePyWorker: vi.fn() }))
vi.mock("@/lib/mining/data-source", () => ({
  acquireBarsSnapshot: vi.fn(),
  getBarsSnapshot: vi.fn(),
  releaseBarsSnapshot: vi.fn(),
  reconcileSnapshotRefs: vi.fn(),
}))
vi.mock("@/lib/mining/device", () => ({
  probeGpu: vi.fn(),
  acquireGpuDevice: vi.fn(),
}))
vi.mock("@/lib/mining/gpu/eval-gpu", () => ({
  createGpuEval: vi.fn(),
  gpuEvalBatch: vi.fn(),
  disposeGpuEval: vi.fn(),
}))
vi.mock("@/lib/mining/gpu/shard-pool", () => ({
  createShardPool: vi.fn(async () => null),
  resolveShardCount: vi.fn(() => 1),
}))

const mockedEnsure = vi.mocked(ensurePyWorker)
const mockedGetSnapshot = vi.mocked(getBarsSnapshot)
const mockedAcquire = vi.mocked(acquireGpuDevice)
const mockedCreateEval = vi.mocked(createGpuEval)
const mockedEvalBatch = vi.mocked(gpuEvalBatch)
const mockedDisposeEval = vi.mocked(disposeGpuEval)

const T = 50
const F = 3

function champ(tokens: number[], composite: number): Champion {
  return { tokens, text: "f", composite, metrics: { composite } as unknown as Champion["metrics"] }
}

let preciseCalls: { candidates: number[][]; best_seen: unknown[] }[] = []
let lostCb: ((reason: string) => void) | null = null

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  preciseCalls = []
  lostCb = null

  mockedGetSnapshot.mockResolvedValue({
    id: "snap-1",
    symbol: "rb2610",
  channel: "binance_spot",
    timeframe: "1d",
    from: "2026-01-01",
    to: "2026-01-31",
    bars: Array.from({ length: 60 }, (_, i) => ({
      time: `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00`,
      open: 100 + i, high: 101 + i, low: 99 + i, close: 100 + i, volume: 10,
    })),
    count: 60,
    fetchedAt: 1,
    sourceHash: "ab",
  })

  const matrix = Array.from({ length: F }, (_, f) =>
    Array.from({ length: T }, (_, t) => Math.sin(f + t / 10)),
  )
  mockedEnsure.mockReturnValue({
    factorRun: vi.fn(async (payload: { mode?: string; candidates?: number[][]; best_seen?: unknown[] }) => {
      if (payload.mode === "mine_gpu_dispose") return { disposed: true }
      if (payload.mode === "mine_features") {
        return {
          feature_names: ["A", "B", "C"],
          matrix,
          periods: 243,
          cost: 0.001,
          train_len: T,
          total_len: 60,
        }
      }
      // mine_precise:冠军 = 首个候选(带固定分),best_seen 透传累积
      preciseCalls.push({ candidates: payload.candidates ?? [], best_seen: payload.best_seen ?? [] })
      const first = payload.candidates?.[0] ?? []
      return {
        champions: [champ(first, 0.9)],
        best_seen: [
          ...(payload.best_seen ?? []),
          { composite: 0.9, tokens: first, metrics: {} },
        ],
      }
    }),
  } as unknown as ReturnType<typeof ensurePyWorker>)

  const fakeDevice = { destroy: vi.fn() }
  mockedAcquire.mockImplementation(async (onLost: (r: string) => void) => {
    lostCb = onLost
    return fakeDevice as unknown as GPUDevice
  })
  mockedCreateEval.mockResolvedValue({
    device: fakeDevice,
    tile: 8,
    T,
    F,
    periods: 243,
    cost: 0.001,
    bufferBytes: 1_242_000_000, // 真实规模参考:tile16384×9×T2000×4 ≈ 1.2GB
  } as unknown as Awaited<ReturnType<typeof createGpuEval>>)

  // 粗排分 = 首个特征 id(确定性排序);EMA token(64+38) → -999
  mockedEvalBatch.mockImplementation(async (_setup, tokensList: number[][]) => {
    const out = new Float32Array(tokensList.length * 11)
    tokensList.forEach((tokens, i) => {
      const hasEma = tokens.some((t) => t === 64 + 38 || t === 64 + 39)
      out[i * 11 + 8] = hasEma ? -999 : tokens[0]
    })
    return out
  })
})

afterEach(() => {
  vi.useRealTimers()
})

const CONFIG = {
  symbol: "rb2610",
  channel: "binance_spot",
  timeframe: "1d",
  population: 6,
  generations: 3,
  max_depth: 3,
  train_ratio: 0.7,
  walk_forward_folds: 0,
  top_n: 2,
  seed: 42,
}

async function loadBackend() {
  return await import("@/lib/mining/backends/gpu-backend")
}

describe("GpuBackend.run", () => {
  it("分代循环:每代粗排→top-K 精算→yield;champions 出自精算", async () => {
    const { GpuBackend } = await loadBackend()
    const gen = new GpuBackend().run({ snapshotId: "snap-1", config: CONFIG, startGeneration: 0 }, new AbortController().signal)

    const gens: number[] = []
    let firstStep: { gpuStats?: { evaluated: number; shardWorkers: number; gpuMemMB: number } } | null = null
    let final: Champion[] = []
    while (true) {
      const r = await gen.next()
      if (r.done) {
        final = r.value
        break
      }
      gens.push(r.value.generation)
      if (!firstStep) firstStep = r.value
      expect(r.value.champions.length).toBeGreaterThan(0) // 精算产物
    }
    expect(gens).toEqual([1, 2, 3])
    // GPU 活动统计:种群规模/缓存命中边界/显存估算/精算并行度(mock 池=null → 0)
    expect(firstStep?.gpuStats?.evaluated).toBe(CONFIG.population)
    expect(firstStep?.gpuStats?.shardWorkers).toBe(0)
    expect(firstStep?.gpuStats?.gpuMemMB).toBeGreaterThanOrEqual(1182)
    expect(final.length).toBeGreaterThan(0)
    // 精算次数 = 代数(无种子无初始 best_seen)
    expect(preciseCalls.length).toBe(3)
    // 每次精算的候选来自当代种群(粗排 top-K 漏斗;width=max(60,6,1)=60,
    // 该测试 trainLen=50 未触发收紧)
    for (const call of preciseCalls) {
      expect(call.candidates.length).toBeGreaterThan(0)
      expect(call.candidates.length).toBeLessThanOrEqual(60)
    }
    expect(mockedDisposeEval).toHaveBeenCalled()
    const rpcCalls = vi.mocked(mockedEnsure().factorRun).mock.calls
    const featureCall = rpcCalls.find(([p]) => (p as { mode: string }).mode === "mine_features")!
    const id = (featureCall[0] as { gpu_session_id: string }).gpu_session_id
    expect(id).toBeTruthy()
    const precisePayloads = rpcCalls.filter(([p]) => (p as { mode: string }).mode === "mine_precise")
      .map(([p]) => p as { final_generation: boolean; crypto_profile: boolean })
    expect(precisePayloads.map((p) => p.final_generation)).toEqual([false, false, true])
    expect(precisePayloads.every((p) => p.crypto_profile === false)).toBe(true)
    for (const [payload, bars] of rpcCalls.filter(([p]) => (p as { mode: string }).mode === "mine_precise")) {
      expect((payload as { gpu_session_id: string }).gpu_session_id).toBe(id)
      expect(bars).toEqual([])
    }
    expect(rpcCalls.at(-1)?.[0]).toEqual({ mode: "mine_gpu_dispose", gpu_session_id: id })
  })

  it("断点续训:startGeneration 跳代,seedBest 先精算注入 best_seen", async () => {
    const { GpuBackend } = await loadBackend()
    const seed = [{ composite: 0.5, tokens: [0], metrics: {} }]
    const gen = new GpuBackend().run(
      { snapshotId: "snap-1", config: { ...CONFIG, generations: 4 }, startGeneration: 2, seedBest: seed },
      new AbortController().signal,
    )

    const gens: number[] = []
    while (true) {
      const r = await gen.next()
      if (r.done) break
      gens.push(r.value.generation)
    }
    expect(gens).toEqual([3, 4]) // 跳过前 2 代
    // 首次精算携带 seedBest(历史最优注入,保证不倒退)
    expect(preciseCalls[0].best_seen).toEqual(seed)
    expect(preciseCalls.length).toBe(3) // 1 次种子注入 + 2 代
  })

  it("abort 在代边界返回已积累 champions", async () => {
    const { GpuBackend } = await loadBackend()
    const ctrl = new AbortController()
    const gen = new GpuBackend().run({ snapshotId: "snap-1", config: CONFIG, startGeneration: 0 }, ctrl.signal)
    const first = await gen.next()
    expect(first.done).toBe(false)
    ctrl.abort()
    const rest = await gen.next()
    expect(rest.done).toBe(true)
    if (rest.done) expect(rest.value.length).toBeGreaterThan(0)
  })

  it("掉设备抛错(由 local-runner 转 paused 可恢复),finally 释放资源", async () => {
    const { GpuBackend } = await loadBackend()
    const gen = new GpuBackend().run({ snapshotId: "snap-1", config: CONFIG, startGeneration: 0 }, new AbortController().signal)
    const first = await gen.next()
    expect(first.done).toBe(false)
    lostCb!("driver reset")
    await expect(gen.next()).rejects.toThrow("WebGPU 设备丢失")
    expect(mockedDisposeEval).toHaveBeenCalled()
  })

  it("快照缺失直接抛错", async () => {
    mockedGetSnapshot.mockResolvedValue(null)
    const { GpuBackend } = await loadBackend()
    const gen = new GpuBackend().run({ snapshotId: "gone", config: CONFIG, startGeneration: 0 }, new AbortController().signal)
    await expect(gen.next()).rejects.toThrow("快照")
  })

  it("精算未完成时预取下一代,关闭生成器前等待未完成的读回", async () => {
    const { GpuBackend } = await loadBackend()
    const py = mockedEnsure()
    const original = py.factorRun
    let finishPrecise!: () => void
    let finishGpu!: () => void
    const preciseGate = new Promise<void>((resolve) => { finishPrecise = resolve })
    const gpuGate = new Promise<void>((resolve) => { finishGpu = resolve })
    py.factorRun = vi.fn(async (...args: Parameters<typeof original>) => {
      if ((args[0] as { mode: string }).mode === "mine_precise") await preciseGate
      return original(...args)
    })
    const originalGpu = mockedEvalBatch.getMockImplementation()!
    mockedEvalBatch
      .mockImplementationOnce(originalGpu)
      .mockImplementationOnce(async (...args) => { await gpuGate; return originalGpu(...args) })
    const gen = new GpuBackend().run({ snapshotId: "snap-1", config: CONFIG, startGeneration: 0 }, new AbortController().signal)
    const first = gen.next()
    await vi.waitFor(() => expect(mockedEvalBatch).toHaveBeenCalledTimes(2))
    expect(mockedDisposeEval).not.toHaveBeenCalled()
    finishPrecise()
    await first
    const closing = gen.return([])
    await Promise.resolve()
    expect(mockedDisposeEval).not.toHaveBeenCalled()
    finishGpu()
    await closing
    expect(mockedDisposeEval).toHaveBeenCalledTimes(1)
  })

  it("设备申请失败仍释放 Python 输入会话", async () => {
    const { GpuBackend } = await loadBackend()
    mockedAcquire.mockRejectedValueOnce(new Error("unavailable"))
    const gen = new GpuBackend().run({ snapshotId: "snap-1", config: CONFIG, startGeneration: 0 }, new AbortController().signal)
    await expect(gen.next()).rejects.toThrow("unavailable")
    expect(vi.mocked(mockedEnsure().factorRun).mock.calls.at(-1)?.[0]).toMatchObject({ mode: "mine_gpu_dispose" })
  })
})
