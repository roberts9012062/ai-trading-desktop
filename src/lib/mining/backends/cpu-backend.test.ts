/**
 * CpuBackend 单测(M3)——mock py-worker,验证分代循环与协议契约:
 * - mine_start 载荷含 islands=1、cost 透传(null 由内核解析)、
 *   start_generation 与 seed_best;
 * - 循环 mine_step 直到 done,yield 每代快照;
 * - 中止(abort)后返回已积累的 champions 并 dispose;
 * - step 出错抛出并 dispose。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ensurePyWorker } from "@/lib/py-worker"
import { getBarsSnapshot } from "@/lib/mining/data-source"
import type { Champion } from "@/lib/factor-lab-api"

vi.mock("@/lib/py-worker", () => ({
  ensurePyWorker: vi.fn(),
}))
vi.mock("@/lib/mining/data-source", () => ({
  getBarsSnapshot: vi.fn(),
}))

const mockedEnsure = vi.mocked(ensurePyWorker)
const mockedGetSnapshot = vi.mocked(getBarsSnapshot)

function champ(tokens: number[], composite: number): Champion {
  return {
    tokens,
    text: `f(${tokens.join(",")})`,
    composite,
    metrics: { composite } as unknown as Champion["metrics"],
  }
}

interface FakePy {
  startPayload: unknown
  startBars: unknown
  steps: unknown[]
  disposed: string[]
}

function fakePy(f: FakePy) {
  const mineStart = vi.fn(async (payload: unknown, bars: unknown) => {
    f.startPayload = payload
    f.startBars = bars
    return { session_id: "s-test" }
  })
  let i = 0
  const mineStep = vi.fn(async () => f.steps[i++] ?? { done: true })
  const mineDispose = vi.fn(async (sid: string) => {
    f.disposed.push(sid)
    return {}
  })
  mockedEnsure.mockReturnValue({
    mineStart,
    mineStep,
    mineDispose,
    run: vi.fn(),
    factorRun: vi.fn(),
    engineRun: vi.fn(),
  } as unknown as ReturnType<typeof ensurePyWorker>)
}

async function loadBackend() {
  return await import("@/lib/mining/backends/cpu-backend")
}

const CONFIG = {
  symbol: "rb2610",
  timeframe: "1d",
  population: 20,
  generations: 3,
  max_depth: 3,
  train_ratio: 0.7,
  walk_forward_folds: 3,
}

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  mockedGetSnapshot.mockResolvedValue({
    id: "snap-1",
    symbol: "rb2610",
    timeframe: "1d",
    from: "2026-01-01",
    to: "2026-01-31",
    bars: [{ time: "2026-01-01T00:00:00", open: 100, high: 101, low: 99, close: 100, volume: 10 }],
    count: 31,
    fetchedAt: 1,
    sourceHash: "ab12cd34",
  })
})

afterEach(() => {
  vi.useRealTimers()
})

describe("CpuBackend.run", () => {
  it("循环 step 直到 done;yield 每代快照;载荷含 islands=1 与续训参数", async () => {
    const f: FakePy = { startPayload: null, startBars: null, steps: [], disposed: [] }
    fakePy(f)
    const c1 = champ([1, 2], 0.5)
    const c2 = champ([3, 4], 0.8)
    f.steps = [
      { done: false, generation: 1, total_generations: 3, best_composite: 0.5, champions: [c1] },
      { done: false, generation: 2, total_generations: 3, best_composite: 0.8, champions: [c2] },
      { done: true },
    ]

    const { CpuBackend } = await loadBackend()
    const gen = new CpuBackend().run(
      { snapshotId: "snap-1", config: { ...CONFIG, cost: null }, startGeneration: 1, seedBest: [{ composite: 0.5, tokens: [1, 2], metrics: {} }] },
      new AbortController().signal,
    )

    const seen: number[] = []
    let final: Champion[] = []
    while (true) {
      const r = await gen.next()
      if (r.done) {
        final = r.value
        break
      }
      seen.push(r.value.generation)
    }

    expect(seen).toEqual([1, 2])
    expect(final).toEqual([c2]) // 最终代 champions 即返回值
    expect(f.startBars).toEqual([
      { time: "2026-01-01T00:00:00", open: 100, high: 101, low: 99, close: 100, volume: 10 },
    ])
    const payload = f.startPayload as Record<string, unknown>
    expect(payload.islands).toBe(1) // 与服务端逐位一致的前提
    expect(payload.cost).toBeNull() // null 由内核按品种解析,不透传数值
    expect(payload.start_generation).toBe(1)
    expect(payload.seed_best).toEqual([{ composite: 0.5, tokens: [1, 2], metrics: {} }])
    expect(f.disposed).toEqual(["s-test"])
  })

  it("快照不存在时直接抛错,不创建会话", async () => {
    mockedGetSnapshot.mockResolvedValue(null)
    const { CpuBackend } = await loadBackend()
    const gen = new CpuBackend().run(
      { snapshotId: "gone", config: CONFIG, startGeneration: 0 },
      new AbortController().signal,
    )
    await expect(gen.next()).rejects.toThrow("快照")
  })

  it("abort 后在代边界返回已积累的 champions 并 dispose", async () => {
    const f: FakePy = { startPayload: null, startBars: null, steps: [], disposed: [] }
    fakePy(f)
    const c1 = champ([1], 0.5)
    f.steps = [
      { done: false, generation: 1, total_generations: 3, best_composite: 0.5, champions: [c1] },
      { done: false, generation: 2, total_generations: 3, best_composite: 0.6, champions: [c1] },
      { done: true },
    ]

    const { CpuBackend } = await loadBackend()
    const ctrl = new AbortController()
    const gen = new CpuBackend().run(
      { snapshotId: "snap-1", config: CONFIG, startGeneration: 0 },
      ctrl.signal,
    )

    const first = await gen.next()
    expect(first.done).toBe(false)
    ctrl.abort() // 模拟 pause:当前代完成后不再 step
    const rest = await gen.next()
    expect(rest.done).toBe(true)
    expect(rest.value).toEqual([c1])
    expect(f.disposed).toEqual(["s-test"])
  })

  it("step 返回 error 时抛出并 dispose", async () => {
    const f: FakePy = { startPayload: null, startBars: null, steps: [], disposed: [] }
    fakePy(f)
    f.steps = [{ error: "会话不存在" }]

    const { CpuBackend } = await loadBackend()
    const gen = new CpuBackend().run(
      { snapshotId: "snap-1", config: CONFIG, startGeneration: 0 },
      new AbortController().signal,
    )
    const expectation = expect(gen.next()).rejects.toThrow("会话不存在")
    await expectation
    expect(f.disposed).toEqual(["s-test"])
  })
})
