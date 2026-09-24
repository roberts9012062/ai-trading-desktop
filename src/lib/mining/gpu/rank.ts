/**
 * rank.ts —— GPU 粗排打分与任务级缓存(深挖强化 M1)
 *
 * 同一任务内 bars 冻结、特征矩阵不变 → 相同 tokens 的粗排分数可跨代复用。
 * 大种群下精英克隆与收敛期重复公式占比高,缓存命中直接跳过 GPU dispatch;
 * 同代种群内的重复候选也只评估一次。缓存键 = tokens.join(","),超上限整体
 * 清空(长跑任务防内存无界,清空后按需重新预热)。
 *
 * 分数语义与 gpu-backend 原逻辑逐字一致:composite <= -998 判无效(-999,
 * 不加 parsimony);其余加 parsimony 罚分(与内核 search.py 同式)。
 */

import { gpuEvalBatch, type GpuEvalSetup } from "./eval-gpu"
import { treeToTokens, type Tree } from "./gp"

/** 缓存条目上限(每条 ~100B,key 为 tokens join;100 万条 ≈ 100MB,
 *  覆盖 3 万种群 × 80 代的唯一公式规模,超限整体清空重建) */
export const RANK_CACHE_MAX = 1_000_000

/** 与 search 的 parsimony 罚分同式 */
export function rankComp(composite: number, tokenLen: number): number {
  return composite - 0.02 * Math.max(0, tokenLen - 12)
}

/** 缓存条目:粗排 composite + evolve_v2 繁殖用的样本外 sortino 与行为指纹 */
export interface RankEntry {
  composite: number
  oos: number
  fp: number
}

/**
 * 行为指纹:年化/sortino/IC 量化到 1e-5 后做 FNV-1a(32 位)。
 * 同一训练段上三者全同 = 同一个因子(写法不同);偶发碰撞只会让一个
 * 个体被当作克隆降权,不影响正确性。
 */
export function metricFingerprint(ann: number, sor: number, ic: number): number {
  let h = 0x811c9dc5
  for (const v of [ann, sor, ic]) {
    const q = Number.isFinite(v) ? Math.max(-2e9, Math.min(2e9, Math.round(v * 1e5))) | 0 : 0
    for (let s = 0; s < 32; s += 8) {
      h = Math.imul(h ^ ((q >>> s) & 0xff), 16777619)
    }
  }
  return h >>> 0
}

export interface RankCache {
  get(key: string): RankEntry | undefined
  has(key: string): boolean
  /** 写入一批粗排结果;超上限时整体清空(由 rankPopulation 批量写完后调用) */
  putBatch(entries: ReadonlyArray<[string, RankEntry]>): void
}

export function createRankCache(): RankCache {
  const scores = new Map<string, RankEntry>()
  return {
    get: (key) => scores.get(key),
    has: (key) => scores.has(key),
    putBatch: (entries) => {
      if (scores.size + entries.length > RANK_CACHE_MAX) scores.clear()
      for (const [key, entry] of entries) scores.set(key, entry)
    },
  }
}

export interface RankedCandidate {
  /** 粗排分(无效为 -999;有效 = composite + parsimony 罚分) */
  comp: number
  tree: Tree
  tokens: number[]
  /** 训练段后 25% 的 sortino(evolve_v2 零平台细分用) */
  oos?: number
  /** 行为指纹(evolve_v2 克隆降权/精算漏斗去重用) */
  fp?: number
}

/** 粗排统计(GPU 活动面板:吞吐/缓存命中/GPU 耗时) */
export interface RankStats {
  /** 实际上 GPU 评估的候选数 */
  gpuEvaluated: number
  /** 缓存命中数(未上 GPU) */
  cacheHits: number
  /** GPU dispatch+读回耗时 ms(含缓存查询与打分的总耗时单列 totalMs) */
  gpuMs: number
  totalMs: number
}

export interface RankOutcome {
  ranked: RankedCandidate[]
  stats: RankStats
}

/**
 * 给整个种群打粗排分:未缓存的唯一 tokens 才送 GPU,结果合并缓存后
 * 按种群顺序返回(顺序与 population 一一对应,供锦标赛/精英使用)。
 */
export async function rankPopulation(
  setup: GpuEvalSetup,
  cache: RankCache,
  population: Tree[],
): Promise<RankOutcome> {
  const t0 = performance.now()
  const entries = population.map((tree) => {
    const tokens = treeToTokens(tree)
    return { tree, tokens, key: tokens.join(",") }
  })
  const pending = new Map<string, number[]>()
  for (const e of entries) {
    if (cache.has(e.key) || pending.has(e.key)) continue
    pending.set(e.key, e.tokens)
  }
  let raw: Float32Array = new Float32Array(0)
  let gpuMs = 0
  if (pending.size > 0) {
    const g0 = performance.now()
    raw = await gpuEvalBatch(setup, [...pending.values()])
    gpuMs = performance.now() - g0
  }
  const written: [string, RankEntry][] = []
  let i = 0
  for (const [key] of pending) {
    const b = i * 9
    const composite = raw[b + 8]
    written.push([
      key,
      composite <= -998
        ? { composite: -999, oos: 0, fp: 0 }
        : { composite, oos: raw[b + 6], fp: metricFingerprint(raw[b], raw[b + 1], raw[b + 3]) },
    ])
    i++
  }
  // Snapshot this generation before putBatch can evict previous cache hits.
  const fresh = new Map(written)
  const ranked = entries.map((e) => {
    const hit = fresh.get(e.key) ?? cache.get(e.key)!
    if (hit.composite === -999) return { comp: -999, tree: e.tree, tokens: e.tokens }
    return {
      comp: rankComp(hit.composite, e.tokens.length),
      tree: e.tree,
      tokens: e.tokens,
      oos: hit.oos,
      fp: hit.fp,
    }
  })
  cache.putBatch(written)
  return {
    ranked,
    stats: {
      gpuEvaluated: pending.size,
      cacheHits: entries.length - pending.size,
      gpuMs,
      totalMs: performance.now() - t0,
    },
  }
}

/**
 * 粗排→精算漏斗宽度:漏斗内每条都由内核 f64 重算(GPU f32 只用于排序,
 * 绝不出数),所以宽度直接决定单代 Pyodide 成本 —— 上限按训练段长度收紧。
 *
 * 实测单条 execute+evaluate_factor(原生 CPython 3.14 + numpy 2.4.6,
 * Pyodide 上再慢 1.5-3 倍):900 根 1.7ms / 2 万根 7.4ms / 12 万根 31.4ms。
 */
export function preciseTopK(population: number, topN: number, trainLen: number): number {
  const cap = trainLen > 30_000 ? 60 : trainLen > 3_000 ? 120 : 200
  return Math.min(cap, Math.max(60, topN * 3, Math.ceil(population * 0.05)))
}

/**
 * 从粗排结果选精算名单(返回种群下标,按粗排分降序)。
 * distinct=true(evolve_v2)时行为指纹相同的只取一个:收敛期头部大多是
 * 同一因子的变体,不去重会让昂贵的 f64 精算名额被克隆吃光。
 */
export function selectPreciseIndices(
  scored: readonly RankedCandidate[],
  topK: number,
  distinct: boolean,
): number[] {
  const order = scored
    .map((s, i) => ({ i, comp: s.comp }))
    .sort((a, b) => b.comp - a.comp)
  if (!distinct) return order.slice(0, topK).map((x) => x.i)
  const seen = new Set<number>()
  const out: number[] = []
  for (const { i, comp } of order) {
    if (out.length >= topK || comp <= -998) break
    const fp = scored[i].fp
    if (fp !== undefined) {
      if (seen.has(fp)) continue
      seen.add(fp)
    }
    out.push(i)
  }
  return out
}
