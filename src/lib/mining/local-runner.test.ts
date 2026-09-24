/**
 * LocalMiningRunner 状态机单测(M3)——注入受控 ComputeBackend:
 * - 完整生命周期 pending→running→(每代持久化)→completed;
 * - 并发上限 1:第二个任务排队,第一个结束后补位;
 * - pause 在代边界生效;resume 以 startGeneration + seed_best 续训(D-1);
 * - 重启恢复:持久化的 pending/running 一律转 paused 并写明原因;
 * - remove 回收快照引用;失败路径区分 failed(无进度)与 paused(中断可恢复);
 * - device 解析:显式 gpu 在 M3 降级 cpu 并标记 degraded。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { IDBFactory } from "fake-indexeddb"
import type { Champion } from "@/lib/factor-lab-api"

vi.mock("@/lib/mining/data-source", () => ({
  acquireBarsSnapshot: vi.fn(),
  getBarsSnapshot: vi.fn(),
  releaseBarsSnapshot: vi.fn(),
  reconcileSnapshotRefs: vi.fn(),
}))

import {
  acquireBarsSnapshot,
  reconcileSnapshotRefs,
  releaseBarsSnapshot,
} from "@/lib/mining/data-source"
import type {
  ComputeBackend,
  EvalRequest,
  GenerationStep,
} from "@/lib/mining/backends/types"

const mockedAcquire = vi.mocked(acquireBarsSnapshot)
const mockedRelease = vi.mocked(releaseBarsSnapshot)
const mockedReconcile = vi.mocked(reconcileSnapshotRefs)

function defer<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

function champ(tokens: number[], composite: number): Champion {
  return {
    tokens,
    text: `f(${tokens.join(",")})`,
    composite,
    metrics: { composite } as unknown as Champion["metrics"],
  }
}

function step(generation: number, champions: Champion[]): GenerationStep {
  return {
    generation,
    totalGenerations: 2,
    bestComposite: champions[0]?.composite ?? 0,
    champions,
    elapsedMs: 5,
  }
}

/** 受控后端:每代一个手动闸门,resolve(GenerationStep|Error) 才推进 */
class GatedBackend implements ComputeBackend {
  device = "cpu" as const
  static requests: EvalRequest[] = []
  gates: { promise: Promise<GenerationStep | Error>; resolve: (v: GenerationStep | Error) => void }[] = []

  addGate() {
    const d = defer<GenerationStep | Error>()
    this.gates.push(d)
    return d.resolve
  }

  async probe() {
    return { available: true }
  }

  async *run(
    req: EvalRequest,
    signal: AbortSignal,
  ): AsyncGenerator<GenerationStep, Champion[], void> {
    GatedBackend.requests.push(req)
    let last: Champion[] = []
    for (const gate of this.gates) {
      if (signal.aborted) return last
      const v = await gate.promise
      if (v instanceof Error) throw v
      last = v.champions
      yield v
    }
    return last
  }

  async dispose() {}
}

const CONFIG = {
  symbol: "rb2610",
  channel: "binance_spot",
  timeframe: "1d",
  population: 10,
  generations: 2,
  max_depth: 3,
  train_ratio: 0.7,
  walk_forward_folds: 0,
}

const SNAPSHOT = {
  id: "snap-1",
  symbol: "rb2610",
  channel: "binance_spot",
  timeframe: "1d",
  from: "2026-01-01",
  to: "2026-01-31",
  bars: [],
  count: 31,
  fetchedAt: 1,
  sourceHash: "ab12cd34",
}

async function loadModules() {
  const { LocalMiningRunner } = await import("@/lib/mining/local-runner")
  return { LocalMiningRunner }
}

async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const t0 = Date.now()
  while (!(await cond())) {
    if (Date.now() - t0 > timeoutMs) throw new Error("waitFor 超时")
    await new Promise((r) => setTimeout(r, 5))
  }
}

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  GatedBackend.requests = []
  vi.stubGlobal("indexedDB", new IDBFactory())
  mockedAcquire.mockResolvedValue(SNAPSHOT)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("LocalMiningRunner", () => {
  it("完整生命周期:pending→running→每代持久化→completed", async () => {
    const { LocalMiningRunner } = await loadModules()
    const backend = new GatedBackend()
    const c1 = champ([1], 0.5)
    const c2 = champ([2], 0.8)
    const g1 = backend.addGate()
    const g2 = backend.addGate()
    const runner = new LocalMiningRunner({ backendFactory: () => backend })
    const events: string[] = []
    runner.subscribe((t) => events.push(`${t.status}@${t.current_generation}`))

    const task = await runner.create(CONFIG, { device: "cpu" })
    // 单槽调度器同步补位:create 返回前任务已从 pending 转 running(事件流
    // 里两条都有)
    expect(task.status).toBe("running")
    expect(events[0]).toBe("pending@0")
    expect(task.origin).toBe("local")
    expect(task.effectiveDevice).toBe("cpu")
    expect(task.bars_count).toBe(31)

    await waitFor(() => events.includes("running@0"))
    g1(step(1, [c1]))
    await waitFor(() => events.includes("running@1"))
    g2(step(2, [c2]))
    await waitFor(() => events.includes("completed@2"))

    const final = await runner.get(task.id)
    expect(final!.status).toBe("completed")
    expect(final!.current_generation).toBe(2)
    expect(final!.progress_pct).toBe(100)
    expect(final!.champions_count).toBe(1)
    expect(await runner.champions(task.id)).toEqual([c2])

    // 每代持久化:记录里存了最近一代 champions 与续训种子摘要
    const store = await import("@/lib/mining/local-store")
    const rec = await store.getLocalTask(task.id)
    expect(rec!.latest_champions).toEqual([c2])
    expect(rec!.best_seen).toEqual([
      { composite: 0.8, tokens: [2], metrics: { composite: 0.8 } },
    ])
  })

  it("并发上限 1:第二个任务排队,第一个结束后补位", async () => {
    const { LocalMiningRunner } = await loadModules()
    // A/B 各自独立的受控后端(共享会话闸门会让 B 复用 A 已 resolve 的代)
    const backendA = new GatedBackend()
    const backendB = new GatedBackend()
    const backends = [backendA, backendB]
    let next = 0
    const runner = new LocalMiningRunner({
      backendFactory: () => backends[next++]!,
    })
    const gA1 = backendA.addGate()
    const gA2 = backendA.addGate()
    const gB1 = backendB.addGate()

    const a = await runner.create(CONFIG, { device: "cpu" })
    await waitFor(() => GatedBackend.requests.length === 1)
    const b = await runner.create({ ...CONFIG, symbol: "hc8888" }, { device: "cpu" })
    expect(b.status).toBe("pending") // A 在跑,B 排队

    gA1(step(1, [champ([1], 0.5)]))
    gA2(step(2, [champ([1], 0.5)]))
    await waitFor(async () => (await runner.get(a.id))!.status === "completed")
    await waitFor(async () => (await runner.get(b.id))!.status === "running")

    // B 的会话请求带自己的配置;补位后再推进 B 的闸门
    expect(GatedBackend.requests[1].config.symbol).toBe("hc8888")
    gB1(step(1, [champ([2], 0.6)]))
    await waitFor(async () => (await runner.get(b.id))!.status === "completed")
  })

  it("pause 在代边界生效;resume 以 startGeneration + seed_best 续训(D-1)", async () => {
    const { LocalMiningRunner } = await loadModules()
    const backend = new GatedBackend()
    const c1 = champ([7], 0.5)
    const g1 = backend.addGate()
    const g2 = backend.addGate() // 暂停后不会再消费
    const runner = new LocalMiningRunner({ backendFactory: () => backend })

    const task = await runner.create(CONFIG, { device: "cpu" })
    await waitFor(() => GatedBackend.requests.length === 1)
    g1(step(1, [c1]))
    await waitFor(async () => (await runner.get(task.id))!.current_generation === 1)

    await runner.pause(task.id)
    const c9 = champ([9], 0.9)
    g2(step(2, [c9])) // 暂停时在飞的那一代会算完并入库(代边界语义),之后不再推进
    await waitFor(async () => (await runner.get(task.id))!.status === "paused")
    expect((await runner.get(task.id))!.current_generation).toBe(2) // 进度含在飞代

    await runner.resume(task.id)
    await waitFor(() => GatedBackend.requests.length === 2)
    const resumeReq = GatedBackend.requests[1]
    expect(resumeReq.startGeneration).toBe(2) // 从第 2 代继续
    expect(resumeReq.seedBest).toEqual([
      { composite: 0.9, tokens: [9], metrics: { composite: 0.9 } },
    ]) // 历史最优作为种子进入新种群
  })

  it("重启恢复:持久化的 running/pending 一律转 paused 并写明原因", async () => {
    // 先在 store 里预置一条 running 记录(模拟应用上次关闭时的状态)
    const store = await import("@/lib/mining/local-store")
    const now = new Date().toISOString()
    await store.putLocalTask({
      id: "local-pre",
      name: "上个会话的任务",
      config: CONFIG,
      deviceWanted: "cpu",
      effectiveDevice: "cpu",
      degraded: false,
      status: "running",
      current_generation: 3,
      progress_pct: 30,
      best_composite: 0.5,
      champions_count: 1,
      latest_champions: [],
      best_seen: [],
      snapshotId: "snap-pre",
      bars_count: 100,
      data_range_from: null,
      data_range_to: null,
      error_msg: null,
      pause_reason: null,
      elapsed_ms: 0,
      started_at: now,
      completed_at: null,
      created_at: now,
      updated_at: now,
    })

    const { LocalMiningRunner } = await loadModules()
    const runner = new LocalMiningRunner({ backendFactory: () => new GatedBackend() })
    const tasks = await runner.list()

    const pre = tasks.find((t) => t.id === "local-pre")
    expect(pre!.status).toBe("paused")
    expect(pre!.pause_reason).toBe("应用重启,已自动暂停,可手动恢复")
    // 非终态任务的快照参与引用计数校准
    expect(mockedReconcile).toHaveBeenCalledWith(["snap-pre"])
  })

  it("remove:删除记录并回收快照引用", async () => {
    const { LocalMiningRunner } = await loadModules()
    const backend = new GatedBackend()
    backend.addGate() // 挂起,保持 running
    const runner = new LocalMiningRunner({ backendFactory: () => backend })
    const task = await runner.create(CONFIG, { device: "cpu" })
    await waitFor(async () => (await runner.get(task.id))!.status === "running")

    await runner.remove(task.id)
    expect(await runner.get(task.id)).toBeNull()
    await waitFor(() => mockedRelease.mock.calls.some((c) => c[0] === "snap-1"))
    expect(mockedRelease).toHaveBeenCalledWith("snap-1")
  })

  it("失败路径:无进度失败→failed;有进度中断→paused 可恢复", async () => {
    const { LocalMiningRunner } = await loadModules()
    const backend = new GatedBackend()
    const g1 = backend.addGate()
    const runner = new LocalMiningRunner({ backendFactory: () => backend })
    const task = await runner.create(CONFIG, { device: "cpu" })
    await waitFor(() => GatedBackend.requests.length === 1)

    g1(new Error("快照数据损坏"))
    await waitFor(async () => (await runner.get(task.id))!.status === "failed")
    expect((await runner.get(task.id))!.error_msg).toContain("快照数据损坏")

    // 第二个任务:先出一带进度,再中断(如共享 worker 被 terminate)
    const backend2 = new GatedBackend()
    const runner2 = new LocalMiningRunner({ backendFactory: () => backend2 })
    const b1 = backend2.addGate()
    const b2 = backend2.addGate()
    const task2 = await runner2.create(CONFIG, { device: "cpu" })
    await waitFor(() => GatedBackend.requests.length === 2)
    b1(step(1, [champ([3], 0.4)]))
    await waitFor(async () => (await runner2.get(task2.id))!.current_generation === 1)
    b2(new Error("worker 异常: terminated"))
    await waitFor(async () => (await runner2.get(task2.id))!.status === "paused")
    const t2 = await runner2.get(task2.id)
    expect(t2!.pause_reason).toContain("本地计算中断")
    expect(t2!.current_generation).toBe(1) // 进度保留,可恢复
  })

  it("device 解析:显式 gpu 在 M3 降级 cpu 并标记 degraded", async () => {
    const { LocalMiningRunner } = await loadModules()
    const backend = new GatedBackend()
    backend.addGate()
    const runner = new LocalMiningRunner({ backendFactory: () => backend })
    const task = await runner.create(CONFIG, { device: "gpu" })
    expect(task.device).toBe("gpu") // 用户意图保留
    expect(task.effectiveDevice).toBe("cpu") // 实际算力
  })
})
