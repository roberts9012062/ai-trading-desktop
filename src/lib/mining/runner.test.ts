/**
 * MiningRunner 工厂 + RemoteMiningRunner 单测(M2)
 *
 * 重点锁定:
 * - 范围硬约束:服务端挖掘 device 恒发 "cpu",调用方误传 gpu 也强制改写;
 * - DTO 映射:origin=remote、device="server";
 * - subscribe 轮询:自适应频率(活跃 5s/空闲 30s)、递归 setTimeout 不堆叠
 *   慢请求(上一次完成才排下一次,P2-18)、退订即停。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  createTask,
  getChampions,
  getTask,
  listTasks,
  pauseTask,
  type CreateTaskPayload,
  type MiningTask as ServerMiningTask,
} from "@/lib/super-factor-api"

vi.mock("@/lib/super-factor-api", () => ({
  POLL_INTERVAL_MS: 5_000,
  createTask: vi.fn(),
  listTasks: vi.fn(),
  getTask: vi.fn(),
  pauseTask: vi.fn(),
  resumeTask: vi.fn(),
  cancelTask: vi.fn(),
  deleteTask: vi.fn(),
  getChampions: vi.fn(),
}))

const mockedCreate = vi.mocked(createTask)
const mockedList = vi.mocked(listTasks)
const mockedGet = vi.mocked(getTask)
const mockedPause = vi.mocked(pauseTask)
const mockedChampions = vi.mocked(getChampions)

function serverTask(id: string, status: ServerMiningTask["status"] = "running"): ServerMiningTask {
  return {
    id,
    name: "超挖·rb2610·1d",
    symbol: "rb2610",
    timeframe: "1d",
    population: 40,
    generations: 30,
    max_depth: 4,
    train_ratio: 0.7,
    walk_forward_folds: 3,
    device: "cpu",
    bars_count: 1000,
    data_range_from: null,
    data_range_to: null,
    status,
    pause_reason: null,
    current_generation: 5,
    best_composite: 1.2,
    progress_pct: 16,
    champions_count: 3,
    error_msg: null,
    started_at: null,
    completed_at: null,
    updated_at: "2026-09-01T00:00:00",
  }
}

const CONFIG = {
  symbol: "rb2610",
  timeframe: "1d",
  population: 40,
  generations: 30,
  max_depth: 4,
  train_ratio: 0.7,
  walk_forward_folds: 3,
}

async function loadRunnerModule() {
  return await import("@/lib/mining/runner")
}

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
})

afterEach(() => {
  vi.useRealTimers()
})

describe("createRunner 工厂", () => {
  it("remote 与 local 均返回单例(共享轮询器/任务状态机)", async () => {
    const { createRunner } = await loadRunnerModule()
    expect(createRunner("remote")).toBe(createRunner("remote"))
    expect(createRunner("local")).toBe(createRunner("local"))
    expect(createRunner("remote")).not.toBe(createRunner("local"))
  })
})

describe("RemoteMiningRunner", () => {
  it("create:device 恒发 cpu(即使调用方误传 gpu),返回统一类型", async () => {
    const { createRunner } = await loadRunnerModule()
    mockedCreate.mockResolvedValue(serverTask("t1", "pending"))

    const task = await createRunner("remote").create(CONFIG, { device: "gpu", name: "n" })

    const payload = mockedCreate.mock.calls[0][0] as CreateTaskPayload
    expect(payload.device).toBe("cpu") // 硬约束:服务端无 GPU 语义
    expect(payload.symbol).toBe("rb2610")
    expect(payload.population).toBe(40)
    expect(task.origin).toBe("remote")
    expect(task.device).toBe("server")
  })

  it("list/get 映射 origin 与 device;get 失败返回 null", async () => {
    const { createRunner } = await loadRunnerModule()
    mockedList.mockResolvedValue([serverTask("a"), serverTask("b", "completed")])
    const list = await createRunner("remote").list()
    expect(list.map((t) => [t.id, t.origin, t.device])).toEqual([
      ["a", "remote", "server"],
      ["b", "remote", "server"],
    ])

    mockedGet.mockResolvedValue(serverTask("a"))
    expect((await createRunner("remote").get("a"))?.id).toBe("a")

    mockedGet.mockRejectedValue(new Error("404"))
    expect(await createRunner("remote").get("nope")).toBeNull()
  })

  it("操作与冠军查询委托到 super-factor-api", async () => {
    const { createRunner } = await loadRunnerModule()
    mockedPause.mockResolvedValue(serverTask("a", "paused"))
    mockedChampions.mockResolvedValue([])
    const r = createRunner("remote")

    await r.pause("a")
    await r.champions("a")
    expect(mockedPause).toHaveBeenCalledWith("a")
    expect(mockedChampions).toHaveBeenCalledWith("a")
  })

  it("subscribe:轮询转逐任务事件,空闲 30s 一拍", async () => {
    vi.useFakeTimers()
    const { createRunner } = await loadRunnerModule()
    mockedList.mockResolvedValue([serverTask("a", "completed")]) // 无活跃任务

    const seen: string[] = []
    const unsub = createRunner("remote").subscribe((t) => seen.push(`${t.id}:${t.origin}`))

    await vi.advanceTimersByTimeAsync(1_000) // 首拍(1s 延迟)
    expect(seen).toEqual(["a:remote"])
    expect(mockedList).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(29_999) // 还没到下一拍(空闲 30s)
    expect(mockedList).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(mockedList).toHaveBeenCalledTimes(2)

    unsub()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(mockedList).toHaveBeenCalledTimes(2) // 退订即停
  })

  it("subscribe:有活跃任务时 5s 一拍", async () => {
    vi.useFakeTimers()
    const { createRunner } = await loadRunnerModule()
    mockedList.mockResolvedValue([serverTask("a", "running")])

    const unsub = createRunner("remote").subscribe(() => {})
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(mockedList).toHaveBeenCalledTimes(2)

    unsub()
  })

  it("subscribe:慢请求不堆叠——上一拍完成前不排下一拍(P2-18)", async () => {
    vi.useFakeTimers()
    const { createRunner } = await loadRunnerModule()
    let release: ((v: ServerMiningTask[]) => void) | null = null
    mockedList.mockImplementation(
      () => new Promise((resolve) => (release = resolve as typeof release)),
    )

    const unsub = createRunner("remote").subscribe(() => {})
    await vi.advanceTimersByTimeAsync(1_000) // 首拍发起,挂起未完成
    await vi.advanceTimersByTimeAsync(120_000) // 即使过了多个周期……

    expect(mockedList).toHaveBeenCalledTimes(1) // 也只有一次在途请求

    release!([serverTask("a", "running")])
    await vi.advanceTimersByTimeAsync(0) // flush 微任务 → 排下一拍
    await vi.advanceTimersByTimeAsync(5_000)
    expect(mockedList).toHaveBeenCalledTimes(2)

    unsub()
  })
})
