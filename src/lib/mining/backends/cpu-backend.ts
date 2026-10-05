/**
 * CpuBackend —— 多核并行本地挖掘(原 M3 单进程内核改为多 worker 架构)
 *
 * 架构(与 GPU 路径同构,粗排算力不同):
 * - 进化(生成/交叉/变异/锦标赛/岛迁移):JS(主线程,毫秒级);
 * - 全种群 f64 评估:分片到 N 个 Pyodide worker 并行(mine_eval_shard,
 *   N=resolveShardCount 按逻辑核数自适应,每实例常驻 ~150MB);
 * - 严格筛/_dedup_top/封存揭示:主实例单点(mine_precise 的 evaluated
 *   并入协议,评估过的候选零重复计算)。
 *
 * 历史包袱说明:M3 曾固定单 worker + islands=1 换"与服务端逐位一致",
 * 服务端挖掘下线后该约束已无意义;单核跑 15m 深历史(600 种群×80 代)
 * 每代 4 分钟、全程近 6 小时只吃一个核,不可接受,故彻底多核化。
 *
 * 池不可用(逻辑核<6 等)时降级为原单进程 mine_start/mine_step 路径,
 * 行为与旧版一致(单核,但永远可用)。
 */

import type { Champion } from "@/lib/factor-lab-api"
import type { KlineBar } from "@/types"
import { ensurePyWorker } from "@/lib/py-worker"
import { getBarsSnapshot } from "../data-source"
import type { MiningConfig } from "../types"
import { filterSearchFeatures } from "@/lib/shortline/search-profile"
import type {
  ComputeBackend,
  EvalRequest,
  GenerationStep,
} from "./types"
import { createShardPool, resolveShardCount, type ShardPool } from "../gpu/shard-pool"
import {
  metricFingerprint,
  preciseTopK,
  rankComp,
  selectPreciseIndices,
  selectPreciseIndicesQuota,
  type RankedCandidate,
} from "../gpu/rank"
import {
  Rng,
  gpuOpSets,
  randomTreeGpuSafe,
  slowBiasedOpSets,
  tokensToTree,
  treeToTokens,
  type Tree,
} from "../gpu/gp"
import { StagnationTracker, nextGeneration, resolveIslands } from "../gpu/evolve"

/** mine_step 的返回契约(降级路径用;factor_local.mine_step) */
interface MineStepResult {
  done?: boolean
  error?: string
  generation?: number
  total_generations?: number
  best_composite?: number
  champions?: Champion[]
}

interface MineFeaturesResult {
  feature_names: string[]
  active_feature_ids?: number[]
  periods: number
  cost: number
  train_len: number
  total_len: number
}

interface EvaluatedEntry {
  composite: number
  tokens: number[]
  metrics: Record<string, unknown>
}

interface MinePreciseResult {
  champions: Champion[]
  best_seen: EvaluatedEntry[]
}

let sessionSeq = 0
function newSessionId(): string {
  sessionSeq += 1
  return `mine-${Date.now().toString(36)}-${sessionSeq}`
}

/** MiningConfig → 内核 SearchConfig 字段(只透传内核认识的键) */
function buildPayload(config: MiningConfig, req: EvalRequest): Record<string, unknown> {
  return {
    symbol: config.symbol,
    crypto_profile: config.crypto_profile ?? false,
    timeframe: config.timeframe,
    population: config.population,
    generations: config.generations,
    max_depth: config.max_depth,
    train_ratio: config.train_ratio,
    ...(config.test_recent_bars != null ? { test_recent_bars: config.test_recent_bars } : {}),
    walk_forward_folds: config.walk_forward_folds,
    islands: 1,
    ...(config.top_n != null ? { top_n: config.top_n } : {}),
    ...(config.seed != null ? { seed: config.seed } : {}),
    // cost=null 由内核按品种+滑点解析(factor-local cost 陷阱:绝不透传 null)
    cost: config.cost ?? null,
    ...(config.seed_tokens?.length ? { seed_tokens: config.seed_tokens } : {}),
    ...(config.search_feature_ids ? { search_feature_ids: config.search_feature_ids } : {}),
    ...(config.cross_peers?.length ? { cross_peers: config.cross_peers } : {}),
    ...(config.selection_v2 ? { selection_v2: true } : {}),
    ...(config.evolve_v2 ? { evolve_v2: true } : {}),
    ...(config.joint_training && config.cross_peers?.length ? { joint_training: true } : {}),
    ...(config.live_entry_gate ? { live_entry_gate: config.live_entry_gate } : {}),
    ...(config.research_profile ? { research_profile: config.research_profile } : {}),
    ...(config.execution_model ? { execution_model: config.execution_model } : {}),
    ...(config.label_span != null ? { label_span: config.label_span } : {}),
    start_generation: req.startGeneration,
    ...(req.seedBest?.length ? { seed_best: req.seedBest } : {}),
  }
}

/** 缓存条目须保 metrics:top-K 命中缓存时经 evaluated 并入需带完整 f64 指标
 *  (内核护栏:缺 sortino 的条目直接丢弃) */
interface EvalCacheEntry extends EvaluatedEntry {
  /** rankComp 后的进化排序分(含 parsimony 罚分) */
  rankedComp: number
  /** 行为指纹(克隆降权) */
  fp: number
}

/** 任务级评估缓存:相同 tokens 的 f64 结果跨代复用(精英克隆/收敛期占比高)。
 *  条目自带 metrics(~500B/条),50 万条上限防内存无界,超限整体清空。 */
const EVAL_CACHE_MAX = 500_000

/** 严格筛分片预取的候选头部数:覆盖 _dedup_top 的 pbo_pool 输入
 *  (非 v2 shortlist = max(3·top_n, top_n+5);v2 distinct 目标 =
 *  max(3·top_n, 30) + 最终代最多两档扩展),取 60 覆盖常规+一档扩展,
 *  未覆盖者主实例回退本地判定(结果一致,只是慢) */
const STRICT_PREFETCH_N = 60

function createEvalCache() {
  const map = new Map<string, EvalCacheEntry>()
  return {
    get: (key: string) => map.get(key),
    put(entries: EvaluatedEntry[]): void {
      if (map.size + entries.length > EVAL_CACHE_MAX) map.clear()
      for (const e of entries) {
        const m = e.metrics ?? {}
        map.set(e.tokens.join(","), {
          ...e,
          rankedComp: rankComp(e.composite, e.tokens.length),
          fp: metricFingerprint(
            Number(m.ann_ret ?? 0),
            Number(m.sortino ?? 0),
            Number(m.ts_ic ?? 0),
          ),
        })
      }
    },
  }
}

export class CpuBackend implements ComputeBackend {
  readonly device = "cpu" as const

  async probe(): Promise<{ available: boolean }> {
    // Pyodide worker 懒加载,能创建即视为可用;真正失败会走 rpc 错误路径
    return { available: true }
  }

  async *run(
    req: EvalRequest,
    signal: AbortSignal,
  ): AsyncGenerator<GenerationStep, Champion[], void> {
    const snapshot = await getBarsSnapshot(req.snapshotId)
    if (!snapshot) {
      throw new Error("K 线快照不存在或已被清理,请删除任务后重新创建")
    }
    if (signal.aborted) throw new Error("已取消")
    return yield* this.runDirect(snapshot.bars, req, signal)
  }

  /** 直接给定 bars 的入口(因子实验室快速搜索已有 bars,无需 IDB 快照) */
  async *runDirect(
    bars: KlineBar[],
    req: EvalRequest,
    signal: AbortSignal,
  ): AsyncGenerator<GenerationStep, Champion[], void> {
    if (signal.aborted) throw new Error("已取消")

    // 主实例特征准备与池 init(内核冷加载+特征矩阵)并行发起:
    // 总启动时间 ≈ 两者较慢者,而不是相加
    const sessionId = crypto.randomUUID()
    const featuresPromise = mineFeatures(req, bars, sessionId)

    // 多核路径:池建不起来(核数不足/初始化全灭)→ 单进程降级
    const pool = await createShardPool({
      bars,
      size: resolveShardCount(),
      payload: buildPayload(req.config, req),
    }).catch(() => null)
    if (!pool) {
      // 降级路径不消费 featuresPromise 的会话输入,显式释放避免泄漏
      await disposeGpuSession(sessionId)
      return yield* runSingleProcess(req, bars, signal)
    }
    try {
      return yield* runParallel(req, bars, pool, signal, sessionId, featuresPromise)
    } finally {
      pool.dispose()
    }
  }

  async dispose(): Promise<void> {
    // 资源在 run() 的 finally 中释放
  }
}

/** 主实例特征准备(mine_features:特征/年化基数/成本率,与 GPU 路径同口径) */
async function mineFeatures(req: EvalRequest, bars: KlineBar[], sessionId: string): Promise<MineFeaturesResult> {
  const cfg = req.config
  const py = ensurePyWorker()
  return (await py.factorRun(
    {
      mode: "mine_features",
      gpu_session_id: sessionId,
      symbol: cfg.symbol,
      crypto_profile: cfg.crypto_profile ?? false,
      timeframe: cfg.timeframe,
      train_ratio: cfg.train_ratio,
      ...(cfg.test_recent_bars != null ? { test_recent_bars: cfg.test_recent_bars } : {}),
      ...(cfg.research_profile ? { research_profile: cfg.research_profile } : {}),
      ...(cfg.execution_model ? { execution_model: cfg.execution_model } : {}),
      ...(cfg.label_span != null ? { label_span: cfg.label_span } : {}),
      cost: cfg.cost ?? null,
    },
    bars,
    300_000,
  )) as MineFeaturesResult
}

/** 释放 mine_features 冻结在内核侧的会话输入(_GPU_INPUTS) */
async function disposeGpuSession(sessionId: string): Promise<void> {
  try {
    await Promise.resolve(
      ensurePyWorker().factorRun({ mode: "mine_gpu_dispose", gpu_session_id: sessionId }, [], 10_000),
    ).catch(() => undefined)
  } catch {
    // 释放失败不阻断任务收尾
  }
}

/** 多核主循环:每代全种群分片 f64 评估 → JS 进化 → top-K 严格筛 */
async function* runParallel(
  req: EvalRequest,
  bars: KlineBar[],
  pool: ShardPool,
  signal: AbortSignal,
  sessionId: string,
  featuresPromise: Promise<MineFeaturesResult>,
): AsyncGenerator<GenerationStep, Champion[], void> {
  const cfg = req.config
  if (signal.aborted) return []
  const py = ensurePyWorker()

  try {
    // 1) 特征/年化基数/成本率(已与池 init 并行预热)
    const features = await featuresPromise

    const F = features.feature_names.length
    const T = features.train_len

    // 2) GP 初始化(与 GPU 路径同构:种子注入种群,历史最优先精算保不倒退)
    const islands = resolveIslands(cfg.population, cfg.islands)
    const active = filterSearchFeatures(features.active_feature_ids ?? Array.from({ length: F }, (_, i) => i), cfg.search_feature_ids)
    if (!active.length) throw new Error("训练段没有可用特征")
    const sampling = cfg.crypto_profile ? [...active, ...active.filter((i) => i >= 45)] : active
    const rng = new Rng((cfg.seed ?? 42) + req.startGeneration, sampling)
    // CPU 内核(pykernel)支持全部 51 算子;与原生/GPU 挖掘同源(m3.3 对齐)
    const gpuOps = gpuOpSets(cfg.crypto_profile ?? false, true)
    const { opOne, opTwo } = slowBiasedOpSets(gpuOps.opOne, gpuOps.opTwo, cfg.timeframe)
    const maxDepth = cfg.max_depth
    const population: Tree[] = []
    for (let i = 0; i < cfg.population; i++) {
      population.push(randomTreeGpuSafe(maxDepth, F, opOne, opTwo, rng, true))
    }
    const seedTokens = cfg.seed_tokens ?? []
    if (seedTokens.some((tokens) => tokens.some((t) => t < 64 && !active.includes(t)))) {
      throw new Error("种子依赖当前训练数据不可用的特征")
    }
    for (let k = 0; k < seedTokens.length && k < population.length; k++) {
      const tree = tokensToTree(seedTokens[k], F)
      if (tree) population[k] = tree
    }

    let lastChampions: Champion[] = []
    let bestSeen: EvaluatedEntry[] = req.seedBest ? [...req.seedBest] : []
    const cache = createEvalCache()
    // 严格筛分片预取:联合训练的伙伴窗口判定依赖主实例上下文,不走分片
    const strictShardable = !(cfg.joint_training && cfg.cross_peers?.length)

    // 3) 严格筛/权威排行:主实例单点(mine_precise),已评估候选经 evaluated 并入。
    //    分片 worker 先对头部候选并行预判严格筛(mine_strict_eval,同构上下文,
    //    verify-strict-shard 对拍保证与本地判定逐位一致),主实例查表零重算。
    const precise = async (evaluated: EvaluatedEntry[], finalGeneration: boolean): Promise<MinePreciseResult> => {
      let prefetchedStrict: Array<{ tokens: number[]; pass: boolean; cross_scores: Record<string, unknown> }> | undefined
      if (strictShardable && evaluated.length > 0) {
        // 预取集合 = _dedup_top 的 pbo_pool 输入超集:历史 best_seen + 当代
        // evaluated 按 composite 降序去重的头部(覆盖非 v2 shortlist 与 v2
        // distinct 目标 + 一档扩展;未覆盖的候选主实例自动回退本地判定)
        const byTokens = new Map<string, EvaluatedEntry>()
        for (const e of [...bestSeen, ...evaluated]) {
          const k = e.tokens.join(",")
          const cur = byTokens.get(k)
          if (!cur || e.composite > cur.composite) byTokens.set(k, e)
        }
        const head = [...byTokens.values()]
          .sort((a, b) => b.composite - a.composite)
          .slice(0, STRICT_PREFETCH_N)
          .map((e) => e.tokens)
        try {
          prefetchedStrict = await pool.evalStrict(head)
        } catch {
          // 预取失败(超时/worker 崩)不阻断:主实例回退本地判定,结果不变
        }
      }
      return (await py.factorRun(
        {
          mode: "mine_precise",
          final_generation: finalGeneration,
          gpu_session_id: sessionId,
          symbol: cfg.symbol,
          crypto_profile: cfg.crypto_profile ?? false,
          timeframe: cfg.timeframe,
          population: cfg.population,
          generations: cfg.generations,
          max_depth: cfg.max_depth,
          train_ratio: cfg.train_ratio,
          ...(cfg.test_recent_bars != null ? { test_recent_bars: cfg.test_recent_bars } : {}),
          walk_forward_folds: cfg.walk_forward_folds,
          top_n: cfg.top_n ?? 10,
          cost: cfg.cost ?? null,
          candidates: [],
          evaluated,
          best_seen: bestSeen,
          trials: cfg.population * cfg.generations,
          ...(cfg.cross_peers?.length ? { cross_peers: cfg.cross_peers } : {}),
          ...(cfg.selection_v2 ? { selection_v2: true } : {}),
          ...(cfg.joint_training && cfg.cross_peers?.length ? { joint_training: true } : {}),
          ...(cfg.live_entry_gate ? { live_entry_gate: cfg.live_entry_gate } : {}),
          ...(cfg.research_profile ? { research_profile: cfg.research_profile } : {}),
          ...(cfg.execution_model ? { execution_model: cfg.execution_model } : {}),
          ...(cfg.label_span != null ? { label_span: cfg.label_span } : {}),
          ...(prefetchedStrict ? { prefetched_strict: prefetchedStrict } : {}),
        },
        [],
        600_000,
      )) as MinePreciseResult
    }

    // 历史种子先精算一次:注入 best_seen,保证续训不倒退
    if (bestSeen.length > 0 || seedTokens.length > 0) {
      const evaluated = seedTokens.length > 0 ? await pool.evalShards(seedTokens) : []
      const res = await precise(evaluated, false)
      bestSeen = res.best_seen
      lastChampions = res.champions
    }

    // 4) 分代主循环(全量 f64 评估[任务级缓存] → 进化 → top-K 严格筛)
    const topK = preciseTopK(cfg.population, cfg.top_n ?? 10, T)
    const evolveV2 = cfg.evolve_v2 === true
    const stagnation = evolveV2 ? new StagnationTracker(islands) : undefined

    for (let genIdx = req.startGeneration; genIdx < cfg.generations; genIdx++) {
      if (signal.aborted) return lastChampions
      const t0 = Date.now()

      // 全种群评估:重复公式命中缓存(克隆/收敛期占比高),未评估的分片并行
      const uncachedTokens: number[][] = []
      const perGen: EvaluatedEntry[] = []
      let cacheHits = 0
      for (const tree of population) {
        const tokens = treeToTokens(tree)
        const hit = cache.get(tokens.join(","))
        if (hit) {
          cacheHits += 1
          perGen.push(hit)
        } else {
          uncachedTokens.push(tokens)
        }
      }
      const evalStart = performance.now()
      const evaluated =
        uncachedTokens.length > 0 ? await pool.evalShards(uncachedTokens) : []
      const evalMs = performance.now() - evalStart
      cache.put(evaluated)
      perGen.push(...evaluated)

      const byKey = new Map(perGen.map((e) => [e.tokens.join(","), e]))
      const scored: RankedCandidate[] = population.map((tree) => {
        const tokens = treeToTokens(tree)
        const key = tokens.join(",")
        const e = byKey.get(key)
        if (!e) return { comp: -999, tree, tokens }
        // cache.put 后必命中;防御性兜底 rankComp
        const cached = cache.get(key)
        return {
          comp: cached ? cached.rankedComp : rankComp(e.composite, tokens.length),
          tree,
          tokens,
          oos: Number.isFinite(Number(e.metrics?.oos_sortino))
            ? Number(e.metrics.oos_sortino)
            : undefined,
          fp: cached?.fp,
        }
      })

      // 精算漏斗与 GPU 路径同构:v2 配额探索 / 普通全局 top-K
      const topCandidates = (evolveV2
        ? selectPreciseIndicesQuota(scored, topK)
        : selectPreciseIndices(scored, topK, evolveV2)
      ).map((i) => scored[i].tokens)

      // 进化下一代(只依赖 f64 分数)
      const nextTrees = nextGeneration(
        scored,
        { population: cfg.population, islands, maxDepth, featN: F, opOne, opTwo, v2: evolveV2, fullOps: true },
        rng,
        genIdx + 1,
        stagnation,
      )
      population.splice(0, population.length, ...nextTrees)

      // top-K 的 f64 结果已产出,作为 evaluated 并入(零重复计算)
      const preciseStart = performance.now()
      const isFinal = genIdx + 1 === cfg.generations
      if (topCandidates.length > 0 || isFinal) {
        const keys = new Set(topCandidates.map((t) => t.join(",")))
        const topEvaluated = perGen.filter((e) => keys.has(e.tokens.join(",")))
        const res = await precise(topEvaluated, isFinal)
        bestSeen = res.best_seen
        lastChampions = res.champions
      }
      const preciseMs = performance.now() - preciseStart

      const bestComposite = lastChampions.reduce((m, c) => Math.max(m, c.composite), -999)
      yield {
        generation: genIdx + 1,
        totalGenerations: cfg.generations,
        bestComposite,
        champions: lastChampions,
        elapsedMs: Date.now() - t0,
        gpuStats: {
          rankMs: Math.round(evalMs),
          evaluated: population.length,
          cacheHits,
          gpuEvaluated: 0,
          preciseMs: Math.round(preciseMs),
          gpuMemMB: 0,
          shardWorkers: pool.size,
        },
      }
      if (signal.aborted) return lastChampions
    }
    return lastChampions
  } finally {
    await disposeGpuSession(sessionId)
  }
}

/** 单进程降级路径(原 M3 行为:mine_start/mine_step 单 worker 单核) */
async function* runSingleProcess(
  req: EvalRequest,
  bars: KlineBar[],
  signal: AbortSignal,
): AsyncGenerator<GenerationStep, Champion[], void> {
  if (signal.aborted) throw new Error("已取消")

  const py = ensurePyWorker()
  const sessionId = newSessionId()
  const startResp = (await py.mineStart(
    { ...buildPayload(req.config, req), session_id: sessionId },
    bars,
  )) as { session_id?: string; error?: string }
  if (startResp && startResp.error) {
    throw new Error(startResp.error)
  }
  const sid = startResp?.session_id ?? sessionId
  let lastChampions: Champion[] = []

  try {
    while (true) {
      if (signal.aborted) return lastChampions
      const t0 = Date.now()
      const step = (await py.mineStep(sid)) as MineStepResult
      if (step && step.error) throw new Error(step.error)
      if (!step || step.done) return lastChampions
      lastChampions = step.champions ?? []
      yield {
        generation: Number(step.generation ?? 0),
        totalGenerations: Number(step.total_generations ?? req.config.generations),
        bestComposite: Number(step.best_composite ?? 0),
        champions: lastChampions,
        elapsedMs: Date.now() - t0,
      }
    }
  } finally {
    await py.mineDispose(sid).catch(() => undefined)
  }
}
