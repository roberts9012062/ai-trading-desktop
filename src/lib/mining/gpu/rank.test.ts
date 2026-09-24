/**
 * rank.ts 单测 —— 粗排缓存与 topK 自适应:
 * - 代内/跨代重复候选只送一次 GPU(缓存命中);
 * - 无效分(-999)不加 parsimony 罚分,与原 gpu-backend 行为一致;
 * - topK 随种群放大并钳制在 [30,100]。
 */
import { describe, expect, it, vi, beforeEach } from "vitest"
import { gpuEvalBatch } from "@/lib/mining/gpu/eval-gpu"

vi.mock("@/lib/mining/gpu/eval-gpu", () => ({
  gpuEvalBatch: vi.fn(),
}))

const mockedBatch = vi.mocked(gpuEvalBatch)
const fakeSetup = {} as Parameters<typeof gpuEvalBatch>[0]

beforeEach(() => {
  mockedBatch.mockReset()
})

describe("rankComp", () => {
  it("token ≤12 不罚,>12 每个罚 0.02", async () => {
    const { rankComp } = await import("@/lib/mining/gpu/rank")
    expect(rankComp(1.0, 12)).toBe(1.0)
    expect(rankComp(1.0, 13)).toBeCloseTo(0.98)
    expect(rankComp(1.0, 32)).toBeCloseTo(0.6)
  })
})

describe("metricFingerprint", () => {
  it("同指标同指纹;1e-5 以上差异分开;非有限值按 0 处理不抛错", async () => {
    const { metricFingerprint } = await import("@/lib/mining/gpu/rank")
    expect(metricFingerprint(0.1, 2, -0.3)).toBe(metricFingerprint(0.1, 2, -0.3))
    expect(metricFingerprint(0.1, 2, -0.3)).not.toBe(metricFingerprint(0.1, 2.001, -0.3))
    expect(metricFingerprint(NaN, Infinity, 0)).toBe(metricFingerprint(NaN, Infinity, 0))
  })
})

describe("selectPreciseIndices", () => {
  it("distinct=false 按粗排分降序取 topK", async () => {
    const { selectPreciseIndices } = await import("@/lib/mining/gpu/rank")
    const scored = [0.1, 0.9, 0.5].map((comp, i) => ({
      comp, tree: ["feat", i] as never, tokens: [i], fp: 7,
    }))
    expect(selectPreciseIndices(scored, 2, false)).toEqual([1, 2])
  })

  it("distinct=true 同指纹只取最优的一个,不足 topK 也不补克隆", async () => {
    const { selectPreciseIndices } = await import("@/lib/mining/gpu/rank")
    const scored = [
      { comp: 0.9, fp: 1 },
      { comp: 0.8, fp: 1 },
      { comp: 0.7, fp: 2 },
    ].map((x, i) => ({ ...x, tree: ["feat", i] as never, tokens: [i] }))
    expect(selectPreciseIndices(scored, 3, true)).toEqual([0, 2])
  })

  it("无效分(-999)不进精算名单", async () => {
    const { selectPreciseIndices } = await import("@/lib/mining/gpu/rank")
    const scored = [
      { comp: -999, fp: 0 },
      { comp: 0.3, fp: 1 },
    ].map((x, i) => ({ ...x, tree: ["feat", i] as never, tokens: [i] }))
    expect(selectPreciseIndices(scored, 5, true)).toEqual([1])
    expect(selectPreciseIndices(scored, 5, false)).toEqual([1, 0])
  })
})

describe("preciseTopK", () => {
  it("宽度按训练段长度钳制:日线 200 / 中等 120 / 分钟线收紧到 60", async () => {
    const { preciseTopK } = await import("@/lib/mining/gpu/rank")
    expect(preciseTopK(40, 10, 900)).toBe(60) // 保底 60
    expect(preciseTopK(2000, 10, 900)).toBe(100) // 5%
    expect(preciseTopK(4000, 10, 900)).toBe(200) // 日线上限
    expect(preciseTopK(4000, 10, 20000)).toBe(120) // 中等数据量收紧
    expect(preciseTopK(4000, 10, 120000)).toBe(60) // 分钟线收到保底
    expect(preciseTopK(100, 50, 900)).toBe(150) // topN*3 未达上限
  })
})

describe("rankPopulation", () => {
  it("缓存达到上限并清空时仍保留本代已命中的分数", async () => {
    const { rankPopulation } = await import("@/lib/mining/gpu/rank")
    const { metricFingerprint } = await import("@/lib/mining/gpu/rank")
    type Entry = { composite: number; oos: number; fp: number }
    const scores = new Map<string, Entry>([
      ["1", { composite: 0.5, oos: 0, fp: metricFingerprint(0, 0, 0) }],
    ])
    const cache = {
      get: (key: string) => scores.get(key),
      has: (key: string) => scores.has(key),
      putBatch: (entries: ReadonlyArray<[string, Entry]>) => {
        scores.clear()
        for (const [key, entry] of entries) scores.set(key, entry)
      },
    }
    mockedBatch.mockResolvedValue(Float32Array.from([0, 0, 0, 0, 0, 0, 0, 0, 0.25]))
    const result = await rankPopulation(fakeSetup, cache, [["feat", 1], ["feat", 2]])
    expect(result.ranked.map((r) => r.comp)).toEqual([0.5, 0.25])
    expect(result.stats.cacheHits).toBe(1)
  })

  it("代内重复与跨代重复只评估一次,分数跨代复用", async () => {
    const { createRankCache, rankPopulation } = await import("@/lib/mining/gpu/rank")
    mockedBatch.mockImplementation(async (_setup: unknown, list: number[][]) => {
      const out = new Float32Array(list.length * 9)
      list.forEach((tokens, i) => {
        out[i * 9 + 8] = tokens[0] / 10
      })
      return out
    })
    const cache = createRankCache()
    // 代 1:三个个体,其中两个公式相同 → GPU 只收到 2 条
    const trees = [
      ["feat", 1],
      ["feat", 1],
      ["feat", 2],
    ] as never[]
    const r1 = await rankPopulation(fakeSetup, cache, trees)
    expect(mockedBatch).toHaveBeenCalledTimes(1)
    expect(mockedBatch.mock.calls[0][1]).toHaveLength(2)
    expect(r1.stats.gpuEvaluated).toBe(2)
    expect(r1.stats.cacheHits).toBe(1) // 重复个体命中缓存
    expect(r1.ranked).toHaveLength(3)
    // 顺序与种群一致,重复公式分数相同
    expect(r1.ranked[0].comp).toBeCloseTo(0.1)
    expect(r1.ranked[1].comp).toBeCloseTo(0.1)
    expect(r1.ranked[2].comp).toBeCloseTo(0.2)
    // 代 2:完全相同种群 → 零 GPU 调用,全缓存命中
    const r2 = await rankPopulation(fakeSetup, cache, trees)
    expect(mockedBatch).toHaveBeenCalledTimes(1)
    expect(r2.stats.gpuEvaluated).toBe(0)
    expect(r2.stats.cacheHits).toBe(3)
  })

  it("无效分(-999)不加罚分,保持 -999", async () => {
    const { createRankCache, rankPopulation } = await import("@/lib/mining/gpu/rank")
    mockedBatch.mockImplementation(async (_setup: unknown, list: number[][]) => {
      const out = new Float32Array(list.length * 9)
      out[8] = -999
      return out
    })
    const cache = createRankCache()
    const r = await rankPopulation(fakeSetup, cache, [
      ["op", 3, ["feat", 1], ["feat", 1], ["feat", 1], ["feat", 2]],
    ] as never[])
    expect(r.ranked[0].comp).toBe(-999)
  })
})
