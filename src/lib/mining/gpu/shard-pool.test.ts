/**
 * shard-pool 单测 —— mock Worker:
 * - size<2 不建池;初始化失败整体 null 且 terminate 已建实例;
 * - evalShards 交错分片、空片不发消息、结果扁平合并;
 * - 分片消息体:首次 init 带 bars,后续 eval 带 [] (内核用缓存)。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

class FakeWorker {
  static instances: FakeWorker[] = []
  /** 类级开关:默认不自动回复(模拟挂起),成功路径用例显式打开 */
  static autoRespond = false
  listeners = new Map<string, Set<(ev: MessageEvent) => void>>()
  posted: Array<Record<string, unknown>> = []
  terminated = false
  /** 消息应答(对 factor_run 回空 evaluated,测试按需替换) */
  responder: (msg: Record<string, unknown>) => Record<string, unknown> | null = (msg) =>
    msg.type === "factor_run"
      ? { type: "result", reqId: msg.reqId, report: { evaluated: [] } }
      : null

  constructor() {
    FakeWorker.instances.push(this)
  }

  addEventListener(type: string, cb: (ev: MessageEvent) => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set())
    this.listeners.get(type)!.add(cb)
  }

  removeEventListener(type: string, cb: (ev: MessageEvent) => void): void {
    this.listeners.get(type)?.delete(cb)
  }

  postMessage(msg: Record<string, unknown>): void {
    this.posted.push(msg)
    if (!FakeWorker.autoRespond) return
    const reply = this.responder(msg)
    if (reply) {
      queueMicrotask(() => {
        for (const cb of this.listeners.get("message") ?? []) {
          cb({ data: reply } as MessageEvent)
        }
      })
    }
  }

  terminate(): void {
    this.terminated = true
  }
}

function stubCores(n: number | undefined): void {
  vi.stubGlobal("navigator", { hardwareConcurrency: n })
}

beforeEach(() => {
  FakeWorker.instances = []
  FakeWorker.autoRespond = false
  vi.stubGlobal("Worker", FakeWorker as unknown as typeof Worker)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

async function load() {
  return await import("@/lib/mining/gpu/shard-pool")
}

describe("resolveShardCount", () => {
  it("按逻辑核数自适应,上限 8 下限 1", async () => {
    const { resolveShardCount } = await load()
    stubCores(8)
    expect(resolveShardCount()).toBe(3)
    stubCores(16)
    expect(resolveShardCount()).toBe(7)
    stubCores(32)
    expect(resolveShardCount()).toBe(8) // 钳上限
    stubCores(2)
    expect(resolveShardCount()).toBe(1)
    stubCores(undefined)
    expect(resolveShardCount()).toBe(3) // 兜底按 8 核
  })
})

describe("createShardPool", () => {
  it("size<2 返回 null(单片无并行意义)", async () => {
    const { createShardPool } = await load()
    const pool = await createShardPool({ bars: [], payload: {}, size: 1 })
    expect(pool).toBeNull()
    expect(FakeWorker.instances).toHaveLength(0)
  })

  it("初始化失败返回 null 并 terminate 已建实例", async () => {
    const { createShardPool } = await load()
    stubCores(8)
    const p = createShardPool({ bars: [], payload: {}, size: 3 })
    await Promise.resolve() // 等 worker 创建
    for (const w of FakeWorker.instances) {
      w.responder = () => null // 不回复,模拟挂起
      for (const cb of w.listeners.get("error") ?? []) cb({} as never) // 触发 error
    }
    expect(await p).toBeNull()
    expect(FakeWorker.instances.every((w) => w.terminated)).toBe(true)
  })

  it("init 带 bars;eval 交错分片+空片跳过+结果扁平;dispose 全部 terminate", async () => {
    const { createShardPool } = await load()
    stubCores(8) // size 由调用方传,这里直接传 2
    FakeWorker.autoRespond = true
    const pool = await createShardPool({ bars: [1, 2], payload: { symbol: "rb" }, size: 2 })
    expect(pool).not.toBeNull()
    // init 消息:mode + 任务参数 + bars
    for (const w of FakeWorker.instances) {
      expect(w.posted[0]).toMatchObject({ type: "factor_run", bars: [1, 2] })
      expect(w.posted[0].payload).toMatchObject({ mode: "mine_eval_shard", symbol: "rb" })
    }
    // eval:5 条候选交错分片 w0=[0,2,4] w1=[1,3];空数组 bars 触发内核缓存
    for (const w of FakeWorker.instances) {
      w.responder = (msg) => {
        const cands = (msg.payload as { candidates: number[][] }).candidates
        return {
          type: "result",
          reqId: msg.reqId,
          report: { evaluated: cands.map((c) => ({ composite: c[0], tokens: c, metrics: {} })) },
        }
      }
    }
    const out = await pool!.evalShards([[1], [2], [3], [4], [5]])
    expect(out.map((e) => e.tokens[0])).toEqual([1, 3, 5, 2, 4])
    expect(FakeWorker.instances[0].posted[1].bars).toEqual([])
    pool!.dispose()
    expect(FakeWorker.instances.every((w) => w.terminated)).toBe(true)
  })
})
