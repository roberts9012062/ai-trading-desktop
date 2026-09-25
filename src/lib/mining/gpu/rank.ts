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

/** 精算漏斗配额(方案 §8.2 默认提议,待消融):
 * 60% 粗排前列不同候选 / 25% 分组(族×复杂度)前列 / 15% 确定性探索。
 */
export interface PreciseQuotas {
  top: number
  group: number
  explore: number
}

export const DEFAULT_PRECISE_QUOTAS: PreciseQuotas = { top: 0.6, group: 0.25, explore: 0.15 }

/** 主要因子族(与内核 archive.family_of 同阈值):直连衍生 > 加密扩展 > 传统量价 */
export function familyOfTokens(tokens: readonly number[]): string {
  const feats = tokens.filter((t) => t >= 0 && t < 64)
  if (feats.some((f) => f >= 52 && f <= 58)) return "direct_deriv"
  if (feats.some((f) => f >= 40 && f <= 51)) return "crypto_v1"
  return "ohlcv_legacy"
}

/** 复杂度档:token 数 /4 截断到 [0,4](与内核 complexity_band 一致) */
export function complexityBand(tokens: readonly number[]): number {
  return Math.min(Math.floor(tokens.length / 4), 4)
}

/** 稳定哈希(FNV-1a 32 位,与 data-source.fnv1a32 同族):确定性探索序 */
function stableHash(tokens: readonly number[]): number {
  let h = 0x811c9dc5
  for (const t of tokens) {
    h ^= t & 0xff
    h = Math.imul(h, 0x01000193) >>> 0
    h ^= (t >>> 8) & 0xff
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

/**
 * 配额制精算漏斗(v2):精算预算不只给全局最高分。
 *
 * - top 配额:粗排分降序、行为指纹去重后的前列(原行为);
 * - group 配额:其余候选按 (族, 复杂度档) 分组轮转取组内最优
 *   (换手档粗排阶段未知,首版不进分组键——内核精算后再分组);
 * - explore 配额:仍未入选者按 tokens 稳定哈希序(等价固定种子抽样);
 * - 无效粗排分(≤-998)不占任何名额;输出按粗排分降序。
 */
export function selectPreciseIndicesQuota(
  scored: readonly RankedCandidate[],
  topK: number,
  quotas: PreciseQuotas = DEFAULT_PRECISE_QUOTAS,
): number[] {
  const order = scored
    .map((s, i) => ({ i, comp: s.comp }))
    .filter((x) => x.comp > -998)
    .sort((a, b) => b.comp - a.comp)
  if (order.length === 0) return []
  const nTop = Math.min(order.length, Math.max(1, Math.round(topK * quotas.top)))
  const nGroup = Math.min(order.length - nTop, Math.round(topK * quotas.group))
  const chosen: number[] = []
  const taken = new Set<number>()
  const seenFp = new Set<number>()
  for (const { i } of order) {
    if (chosen.length >= nTop) break
    const fp = scored[i].fp
    if (fp !== undefined) {
      if (seenFp.has(fp)) continue
      seenFp.add(fp)
    }
    chosen.push(i)
    taken.add(i)
  }
  // 分组轮转:rest 按 (族, 复杂度) 分组,组内已按分排序
  const groups = new Map<string, number[]>()
  for (const { i } of order) {
    if (taken.has(i)) continue
    const key = `${familyOfTokens(scored[i].tokens)}:${complexityBand(scored[i].tokens)}`
    const g = groups.get(key) ?? []
    g.push(i)
    groups.set(key, g)
  }
  const keys = [...groups.keys()].sort()
  let groupBudget = nGroup
  while (groupBudget > 0 && keys.some((k) => (groups.get(k)?.length ?? 0) > 0)) {
    let progressed = false
    for (const k of keys) {
      const g = groups.get(k)!
      if (!g.length || groupBudget <= 0) continue
      const i = g.shift()!
      chosen.push(i)
      taken.add(i)
      groupBudget -= 1
      progressed = true
    }
    if (!progressed) break
  }
  // 确定性探索:余下按稳定哈希序补满 topK
  const rest = order.filter(({ i }) => !taken.has(i))
  rest.sort((a, b) => stableHash(scored[a.i].tokens) - stableHash(scored[b.i].tokens))
  for (const { i } of rest) {
    if (chosen.length >= topK) break
    chosen.push(i)
  }
  // 输出按粗排分降序(精算入口不关心顺序,但确定性输出便于测试与复现)
  return chosen.sort((a, b) => scored[b].comp - scored[a].comp)
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
