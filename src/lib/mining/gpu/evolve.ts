/**
 * evolve.ts —— GPU 路径岛模型进化(深挖强化 M2)
 *
 * 与内核 search.py 岛模型语义同构:种群连续等分成 N 岛,每岛独立
 * 精英+锦标赛(k=3)+交叉(0.6)/变异(0.3);每 MIGRATE_EVERY 代各岛
 * top-2 克隆环状迁移到下一岛(替换其随机成员)。islands=1 时退化为
 * 原单种群行为。岛是种群的连续切片(初始化与每代切法一致,RNG 顺序
 * 确定可复现)。CPU 路径不经过本文件(保持与服务端逐位一致)。
 */

import type { RankedCandidate } from "./rank"
import {
  Rng,
  cloneTree,
  crossover,
  gpuSafeChild,
  mutate,
  mutateV2,
  randomTreeGpuSafe,
  tournament,
  type Tree,
} from "./gp"

/** 与 search.py 岛模型迁移节奏一致 */
export const MIGRATE_EVERY = 5
/** 与 search.py 一致:每岛至少 5 个个体 */
export const MIN_ISLAND_SIZE = 5
/** evolve_v2:连续多少代最优键无提升视为停滞 / 停滞时随机新个体占比(同 search.py) */
export const STAGNATION_GENS = 8
export const RESTART_FRACTION = 0.3

export interface EvolveOptions {
  population: number
  /** 已解析的岛数(≥1;调用方先过 resolveIslands) */
  islands: number
  maxDepth: number
  featN: number
  opOne: readonly number[]
  opTwo: readonly number[]
  /** 进化增强(evolve_v2):点/收缩变异、克隆降权、零平台细分、停滞重启 */
  v2?: boolean
}

/** 解析合法岛数:钳到 [1, floor(population/5)];未配置/非法 → 1 */
export function resolveIslands(population: number, islands: number | undefined): number {
  if (!islands || !Number.isFinite(islands) || islands <= 1) return 1
  return Math.max(1, Math.min(Math.floor(islands), Math.floor(population / MIN_ISLAND_SIZE)))
}

/** 岛切片边界 [lo, hi):连续等分,余数摊给前面的岛 */
export function islandSlices(total: number, islands: number): Array<[number, number]> {
  const size = Math.floor(total / islands)
  const rem = total - size * islands
  const slices: Array<[number, number]> = []
  let start = 0
  for (let i = 0; i < islands; i++) {
    const len = size + (i < rem ? 1 : 0)
    slices.push([start, start + len])
    start += len
  }
  return slices
}

/** 单岛进化下一代:精英(10%)克隆 + 锦标赛选择 + 交叉/变异(与原单种群逻辑同式);
 *  fresh>0 时尾部用随机新个体补齐(evolve_v2 停滞重启) */
function evolveIsland(
  scored: RankedCandidate[],
  size: number,
  opts: EvolveOptions,
  rng: Rng,
  fresh = 0,
): Tree[] {
  const eliteN = Math.max(2, Math.floor(size / 10))
  const sorted = [...scored].sort((a, b) => b.comp - a.comp)
  const next: Tree[] = sorted.slice(0, eliteN).map((s) => cloneTree(s.tree))
  const crossoverP = 0.6
  const mutationP = 0.3
  const doMutate = opts.v2 ? mutateV2 : mutate
  while (next.length < size - fresh) {
    const mom = tournament(scored, rng)
    let child: Tree
    if (rng.next() < crossoverP && scored.length > 1) {
      child = crossover(mom, tournament(scored, rng), rng)
    } else {
      child = cloneTree(mom)
    }
    if (rng.next() < mutationP) {
      child = doMutate(child, opts.featN, opts.opOne, opts.opTwo, rng, opts.maxDepth)
    }
    next.push(gpuSafeChild(child, mom, opts.featN))
  }
  while (next.length < size) {
    next.push(randomTreeGpuSafe(opts.maxDepth, opts.featN, opts.opOne, opts.opTwo, rng))
  }
  return next
}

/**
 * evolve_v2 繁殖排序键(与 search.py _rank_v2 同构;不改粗排分本身):
 * - OOS 零平台细分:样本外为负的候选被 ×0 压成并列 0,加 0.02·tanh(oos)
 *   让"亏得少"的排前,给搜索指向样本外转正的梯度;
 * - 分块稳健性:正 composite 按训练段正 sortino 块占比打折(0.25+0.75·占比),
 *   再加 0.02·tanh(最差块 sortino)——只在一段行情里赚钱的个体降低选择压力;
 * - 行为克隆降权:与已出现者指纹相同的个体键 -1,不占精英/锦标赛名额。
 * 返回与入参同序的副本(岛切片仍按种群顺序)。
 */
export function rankKeysV2(scored: readonly RankedCandidate[]): RankedCandidate[] {
  const order = scored.map((_, i) => i).sort((a, b) => scored[b].comp - scored[a].comp)
  const out = scored.map((s) => ({ ...s }))
  const seen = new Set<number>()
  for (const i of order) {
    const s = out[i]
    if (s.comp <= -998) continue
    if (s.blockPos !== undefined) {
      if (s.comp > 0) s.comp *= 0.25 + 0.75 * s.blockPos
      s.comp += 0.02 * Math.tanh(s.blockMin ?? 0)
    }
    if (s.oos !== undefined && s.oos <= 0) s.comp += 0.02 * Math.tanh(s.oos)
    if (s.fp !== undefined) {
      if (seen.has(s.fp)) s.comp -= 1
      else seen.add(s.fp)
    }
  }
  return out
}

/** 每岛最优排序键的停滞计数(evolve_v2 重启触发器,同 search.py _Stagnation) */
export class StagnationTracker {
  private best: number[]
  private stall: number[]
  constructor(islands: number) {
    this.best = new Array<number>(islands).fill(-Infinity)
    this.stall = new Array<number>(islands).fill(0)
  }
  /** 记录本代最优;返回本次繁殖是否应注入随机新个体(并清零计数) */
  update(island: number, bestKey: number): boolean {
    if (bestKey > this.best[island] + 1e-9) {
      this.best[island] = bestKey
      this.stall[island] = 0
      return false
    }
    this.stall[island] += 1
    if (this.stall[island] >= STAGNATION_GENS) {
      this.stall[island] = 0
      return true
    }
    return false
  }
}

/** 环状迁移:各岛 top-2 克隆替换下一岛的 2 个随机成员 */
function migrateIslands(
  islandTrees: Tree[][],
  islandScored: RankedCandidate[][],
  rng: Rng,
): void {
  const tops = islandScored.map((scored) =>
    [...scored].sort((a, b) => b.comp - a.comp).slice(0, 2).map((s) => s.tree),
  )
  for (let i = 0; i < islandTrees.length; i++) {
    const target = islandTrees[(i + 1) % islandTrees.length]
    for (const donor of tops[i]) {
      if (target.length === 0) break
      target[rng.randrange(target.length)] = cloneTree(donor)
    }
  }
}

/** 由当代打分产出下一代种群;generation 为已完成代数(1-based),控制迁移节奏。
 *  opts.v2 时须传 stagnation(跨代持有),按 rankKeysV2 键繁殖并做停滞重启 */
export function nextGeneration(
  scored: RankedCandidate[],
  opts: EvolveOptions,
  rng: Rng,
  generation: number,
  stagnation?: StagnationTracker,
): Tree[] {
  const keyed = opts.v2 ? rankKeysV2(scored) : scored
  const slices = islandSlices(keyed.length, opts.islands)
  const islandScored = slices.map(([lo, hi]) => keyed.slice(lo, hi))
  const nextTrees = islandScored.map((island, i) => {
    const size = slices[i][1] - slices[i][0]
    let fresh = 0
    if (opts.v2 && stagnation && island.length > 0) {
      const best = island.reduce((m, s) => Math.max(m, s.comp), -Infinity)
      if (stagnation.update(i, best)) fresh = Math.floor(size * RESTART_FRACTION)
    }
    return evolveIsland(island, size, opts, rng, fresh)
  })
  if (opts.islands > 1 && generation % MIGRATE_EVERY === 0) {
    migrateIslands(nextTrees, islandScored, rng)
  }
  return nextTrees.flat()
}
