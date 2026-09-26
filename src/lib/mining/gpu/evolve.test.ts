/**
 * evolve.ts 单测 —— 岛模型进化:
 * - resolveIslands 钳制(每岛 ≥5 个体,非法输入回落单岛);
 * - islandSlices 连续等分覆盖全部个体;
 * - nextGeneration 保持种群规模;迁移代不破坏规模;
 * - islands=1 与岛模型在相同输入下规模/合法性一致。
 */
import { describe, expect, it } from "vitest"
import {
  MIGRATE_EVERY,
  RESTART_FRACTION,
  STAGNATION_GENS,
  StagnationTracker,
  islandSlices,
  nextGeneration,
  rankKeysV2,
  resolveIslands,
  type EvolveOptions,
} from "@/lib/mining/gpu/evolve"
import { Rng, randomTreeGpuSafe, gpuOpSets, treeToTokens } from "@/lib/mining/gpu/gp"
import { metricFingerprint, type RankedCandidate } from "@/lib/mining/gpu/rank"
import { tokensGpuSupported } from "@/lib/mining/gpu/tokens"

const F = 4
const { opOne, opTwo } = gpuOpSets()

function opts(islands: number, population: number, v2 = false): EvolveOptions {
  return { population, islands, maxDepth: 3, featN: F, opOne, opTwo, v2 }
}

/** 造一组打分候选(comp 递减);fp/oos 可选,用于 v2 的克隆降权与零平台细分 */
function makeScored(
  n: number,
  rng: Rng,
  extra?: (i: number) => Partial<RankedCandidate>,
): RankedCandidate[] {
  return Array.from({ length: n }, (_, i) => {
    const tree = randomTreeGpuSafe(3, F, opOne, opTwo, rng)
    return {
      comp: 1 - i / n,
      tree,
      tokens: treeToTokens(tree),
      ...(extra ? extra(i) : {}),
    }
  })
}

describe("resolveIslands", () => {
  it("未配置/非法回落 1;每岛至少 5 个体钳制", () => {
    expect(resolveIslands(40, undefined)).toBe(1)
    expect(resolveIslands(40, 0)).toBe(1)
    expect(resolveIslands(40, 2)).toBe(2)
    expect(resolveIslands(20, 8)).toBe(4) // floor(20/5)=4
    expect(resolveIslands(9, 4)).toBe(1) // 不足每岛 5 个
  })
})

describe("islandSlices", () => {
  it("连续等分覆盖全部个体,余数摊给前面的岛", () => {
    expect(islandSlices(10, 2)).toEqual([[0, 5], [5, 10]])
    expect(islandSlices(11, 3)).toEqual([[0, 4], [4, 8], [8, 11]])
    const total = islandSlices(1000, 4).reduce((s, [lo, hi]) => s + (hi - lo), 0)
    expect(total).toBe(1000)
  })
})

describe("nextGeneration", () => {
  it("保持种群规模,产出的 tokens 全部 GPU 合法", () => {
    const population = 40
    const rng = new Rng(7)
    const trees = Array.from({ length: population }, () =>
      randomTreeGpuSafe(3, F, opOne, opTwo, rng))
    const scored = trees.map((tree, i) => ({
      comp: (i % 7) / 7,
      tree,
      tokens: treeToTokens(tree),
    }))
    const next = nextGeneration(scored, opts(4, population), rng, 1)
    expect(next).toHaveLength(population)
    for (const tree of next) {
      expect(tokensGpuSupported(treeToTokens(tree), F)).toBe(true)
    }
  })

  it("迁移代(MIGRATE_EVERY 的倍数)规模不变", () => {
    const population = 30
    const rng = new Rng(3)
    const trees = Array.from({ length: population }, () =>
      randomTreeGpuSafe(3, F, opOne, opTwo, rng))
    const scored = trees.map((tree, i) => ({
      comp: i / population,
      tree,
      tokens: treeToTokens(tree),
    }))
    const next = nextGeneration(scored, opts(3, population), rng, MIGRATE_EVERY)
    expect(next).toHaveLength(population)
  })

  it("v2:规模不变且 tokens 全部 GPU 合法(点/收缩变异不越界)", () => {
    const population = 60
    const rng = new Rng(11)
    const scored = makeScored(population, rng, (i) => ({
      oos: i % 2 === 0 ? -0.5 : 0.5,
      fp: metricFingerprint(i % 5, i % 5, i % 5),
    }))
    const next = nextGeneration(
      scored, opts(3, population, true), rng, 1, new StagnationTracker(3),
    )
    expect(next).toHaveLength(population)
    for (const tree of next) {
      expect(tokensGpuSupported(treeToTokens(tree), F)).toBe(true)
    }
  })
})

describe("rankKeysV2", () => {
  it("样本外为负者按 tanh(oos) 细分零平台,量级 ≤0.02", () => {
    const rng = new Rng(5)
    const base = makeScored(2, rng)
    const keyed = rankKeysV2([
      { ...base[0], comp: 0, oos: -0.5 },
      { ...base[1], comp: 0, oos: -2 },
    ])
    // 亏得少的排前;两者都仍在 (-0.02, 0]
    expect(keyed[0].comp).toBeGreaterThan(keyed[1].comp)
    expect(keyed[0].comp).toBeLessThanOrEqual(0)
    expect(keyed[1].comp).toBeGreaterThan(-0.02)
  })

  it("同指纹的后来者键 -1(克隆降权),首个保留原键", () => {
    const rng = new Rng(6)
    const base = makeScored(3, rng)
    const fp = metricFingerprint(1, 2, 3)
    const keyed = rankKeysV2([
      { ...base[0], comp: 0.9, oos: 1, fp },
      { ...base[1], comp: 0.8, oos: 1, fp },
      { ...base[2], comp: 0.7, oos: 1, fp: metricFingerprint(4, 5, 6) },
    ])
    expect(keyed[0].comp).toBeCloseTo(0.9)
    expect(keyed[1].comp).toBeCloseTo(-0.2) // 0.8 - 1
    expect(keyed[2].comp).toBeCloseTo(0.7)
  })

  it("无效分(-999)不参与细分与降权", () => {
    const rng = new Rng(8)
    const base = makeScored(1, rng)
    const keyed = rankKeysV2([{ ...base[0], comp: -999, oos: -3, fp: 1 }])
    expect(keyed[0].comp).toBe(-999)
  })

  it("分块稳健性:只在少数块赚钱的候选被打折,与 search.py _robust_key 同式", () => {
    const rng = new Rng(9)
    const base = makeScored(2, rng)
    const keyed = rankKeysV2([
      { ...base[0], comp: 1.0, blockPos: 0.25, blockMin: -1 },
      { ...base[1], comp: 0.6, blockPos: 1, blockMin: 0.5 },
    ])
    expect(keyed[0].comp).toBeCloseTo(1.0 * (0.25 + 0.75 * 0.25) + 0.02 * Math.tanh(-1))
    expect(keyed[1].comp).toBeCloseTo(0.6 + 0.02 * Math.tanh(0.5))
    // 训练分更高但只在一块行情里赚钱的,排到各段都赚钱的后面
    expect(keyed[1].comp).toBeGreaterThan(keyed[0].comp)
  })
})

describe("StagnationTracker", () => {
  it("有提升清零;连续 STAGNATION_GENS 代无提升触发一次重启后清零", () => {
    const st = new StagnationTracker(1)
    expect(st.update(0, 1)).toBe(false)
    for (let i = 0; i < STAGNATION_GENS - 1; i++) expect(st.update(0, 1)).toBe(false)
    expect(st.update(0, 1)).toBe(true)
    expect(st.update(0, 1)).toBe(false) // 计数已清零
    expect(st.update(0, 2)).toBe(false) // 有提升
  })

  it("重启代注入随机新个体,规模仍不变", () => {
    const population = 40
    const rng = new Rng(13)
    const scored = makeScored(population, rng, () => ({ oos: 1, fp: 0 }))
    const st = new StagnationTracker(1)
    let next: unknown[] = []
    for (let g = 1; g <= STAGNATION_GENS + 1; g++) {
      next = nextGeneration(scored, opts(1, population, true), rng, g, st)
    }
    expect(next).toHaveLength(population)
    expect(Math.floor(population * RESTART_FRACTION)).toBeGreaterThan(0)
  })
})
