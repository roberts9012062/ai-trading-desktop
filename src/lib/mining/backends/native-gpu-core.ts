import type { Champion } from "@/lib/factor-lab-api"
import { filterSearchFeatures } from "@/lib/shortline/search-profile"
import { maxResearchBars } from "@/lib/device-profile"
import { packNativeBars, type NativeBar } from "@/lib/native-engine/bars"
import { NativeEngineError, type NativeEngineClient } from "@/lib/native-engine/ipc"
import type { NativeHello, NativePreciseResult } from "@/lib/native-engine/types"
import { Rng, gpuOpSets, randomTreeGpuSafe, slowBiasedOpSets, tokensToTree, treeToTokens, type Tree } from "../gpu/gp"
import { nextGeneration, resolveIslands, StagnationTracker } from "../gpu/evolve"
import { preciseTopK, selectPreciseIndices, selectPreciseIndicesQuota, type RankedCandidate } from "../gpu/rank"
import type { EvalRequest, GenerationStep, SerializedBest } from "./types"
import { compatibleTrainingSeeds } from "../seed-compatibility"

export type NativeSessionClient = Pick<NativeEngineClient,
  "loadBars" | "mineFeatures" | "rankShards" | "evalShards" | "strictEval" | "precise" | "disposeSession">

export interface NativeGenerationStep extends GenerationStep {
  engineTag: "native-gpu-v1"
  engineVersion: string
  bestSeen: SerializedBest[]
  researchCandidates: NativePreciseResult["research_candidates"]
  pendingCandidates: NativePreciseResult["pending_candidates"]
  rejectedCandidates: NativePreciseResult["rejected_candidates"]
  /** 研究级冠军:被拒原因全部属于成本/执行压力类(其余门全过,含封存段 1× 盈利) */
  researchChampions: Champion[]
}

/** 执行级专属门槛:考验的是加倍成本/实盘执行的鲁棒性,而非样本外有效性 */
const EXECUTION_ONLY_BLOCKERS = new Set([
  "holdout_stress_failed_or_missing",
  "holdout_live_entry_failed",
  "live_fill_failed_or_missing",
  "execution_failed_or_missing",
])

/** 研究级冠军 = 被拒原因全部属于执行级门槛的候选——样本外 1× 已盈利、
 *  Walk-Forward/严格筛/验证段全过,仅未扛住 2× 成本压力。如实分级展示,
 *  不与过全门的执行级冠军混淆。 */
export function researchGradeChampions(
  rejected: NativePreciseResult["rejected_candidates"],
): Champion[] {
  return rejected
    .filter((row) => {
      const reasons = row.qualification?.reasons ?? []
      return reasons.length > 0 && reasons.every((r) => EXECUTION_ONLY_BLOCKERS.has(r))
    })
    .map((row) => ({
      tokens: row.tokens,
      text: row.text,
      composite: row.composite,
      metrics: row.metrics as unknown as Champion["metrics"],
    }))
}

function publicChampions(result: NativePreciseResult, version: string): Champion[] {
  for (const row of result.champions) {
    const metrics = row.metrics
    if (row.qualification?.status !== "qualified" || row.qualification.reasons.length !== 0 ||
        metrics.native_strict_passed !== true || metrics.kernel_version !== "native-gpu-v1" ||
        metrics.native_eval_precision !== "f64" || metrics.native_engine_version !== version ||
        !Number.isFinite(row.composite) || !Number.isFinite(metrics.sortino) || !Number.isFinite(metrics.ann_ret)) {
      throw new NativeEngineError("原生冠军版本或合格证据不完整", "INVALID_QUALIFICATION")
    }
  }
  // The server owns the validated numerical schema; retain provenance and
  // qualification on each row when adapting to the existing desktop DTO.
  return result.champions as unknown as Champion[]
}

/** Same JS evolution as the existing GPU path; all numerical work uses IPC. */
export async function* runNativeGpuSession(
  client: NativeSessionClient, hello: NativeHello, bars: NativeBar[], req: EvalRequest,
  signal: AbortSignal, session = crypto.randomUUID(),
): AsyncGenerator<NativeGenerationStep, Champion[], void> {
  let champions: Champion[] = []
  if (signal.aborted) return champions
  try {
    const cfg = req.config, limit = maxResearchBars()
    if (limit !== 100000 && limit !== 200000 && limit !== 300000) throw new Error("无效的设备内存档位")
    const packed = packNativeBars(bars, limit, req.snapshotId)
    await client.loadBars(session, packed.columns, packed.metadata)
    if (signal.aborted) return champions
    const features = await client.mineFeatures(session, cfg)
    if (features.features_source !== "gpu-taichi") throw new NativeEngineError("原生特征未在 GPU 上生成", "INVALID_FEATURES")
    if (signal.aborted) return champions
    const F = features.feature_names.length
    const active = filterSearchFeatures(features.active_feature_ids, cfg.search_feature_ids)
    if (!active.length) throw new Error("训练段没有可用特征")
    const sampling = cfg.crypto_profile ? [...active, ...active.filter(id => id >= 45)] : active
    const rng = new Rng((cfg.seed ?? 42) + req.startGeneration, sampling)
    // 原生引擎 m3.3 起支持全部 51 算子(与 CPU 内核同源);WebGPU 仍走裁剪集
    const gpuOps = gpuOpSets(cfg.crypto_profile ?? false, true)
    const { opOne, opTwo } = slowBiasedOpSets(gpuOps.opOne, gpuOps.opTwo, cfg.timeframe)
    const islands = resolveIslands(cfg.population, cfg.islands)
    const evolveV2 = cfg.evolve_v2 === true
    const stagnation = evolveV2 ? new StagnationTracker(islands) : undefined
    let population: Tree[] = Array.from({ length: cfg.population }, () => randomTreeGpuSafe(cfg.max_depth, F, opOne, opTwo, rng, true))
    const {seeds:seedTokens,warning:seedWarning} = compatibleTrainingSeeds(cfg,active,features.feature_names)
    for (let i = 0; i < Math.min(seedTokens.length, population.length); i++) {
      const tree = tokensToTree(seedTokens[i], F)
      if (tree) population[i] = tree
    }
    // Current-version training summaries may cross a D-1 boundary. Sealed
    // holdout and qualification outcomes never feed scores or reproduction.
    let bestSeen = (req.seedBest ?? []).filter(row => row.metrics.kernel_version === "native-gpu-v1" &&
      row.metrics.native_eval_precision === "f64" && row.metrics.native_engine_version === hello.engine_version)
    const precise = async (tokens: number[][], final: boolean) => {
      const { evaluated } = await client.evalShards(session, tokens)
      const head = new Map<string, SerializedBest>()
      for (const row of [...bestSeen, ...evaluated]) {
        const key = row.tokens.join(","), old = head.get(key)
        if (!old || row.composite > old.composite) head.set(key, row)
      }
      const strictTokens = [...head.values()].sort((a, b) => b.composite - a.composite).slice(0, 60).map(row => row.tokens)
      const { strict } = await client.strictEval(session, strictTokens)
      return client.precise(session, { evaluated, best_seen: bestSeen, prefetched_strict: strict,
        trials: cfg.population * cfg.generations, final_generation: final, include_portfolio: final,
        combo_super: cfg.combo_super === true })
    }
    // Matches the M2 G3 warmup: numerical session setup does not seed archives.
    const warm = population.slice(0, 8).map(treeToTokens)
    await client.evalShards(session, warm)
    if (hello.precision === "mixed") await client.rankShards(session, warm)
    if (bestSeen.length || seedTokens.length) {
      const result = await precise(seedTokens, false)
      bestSeen = result.best_seen
      champions = publicChampions(result, hello.engine_version)
    }
    if (signal.aborted) return champions
    const cache = new Map<string, number>()
    const topK = preciseTopK(cfg.population, cfg.top_n ?? 10, features.train_len)
    for (let gen = req.startGeneration; gen < cfg.generations; gen++) {
      if (signal.aborted) return champions
      const start = performance.now()
      const entries = population.map(tree => { const tokens = treeToTokens(tree); return { tree, tokens, key: tokens.join(",") } })
      const pending = new Map<string, number[]>()
      for (const row of entries) if (!cache.has(row.key)) pending.set(row.key, row.tokens)
      const rankStart = performance.now()
      if (pending.size) {
        const tokens = [...pending.values()]
        const fresh = hello.precision === "mixed"
          ? (await client.rankShards(session, tokens)).ranked.map(row => ({ tokens: row.tokens, score: row.score }))
          : (await client.evalShards(session, tokens)).evaluated.map(row => ({ tokens: row.tokens, score: row.composite }))
        const byKey = new Map(fresh.map(row => [row.tokens.join(","), row.score]))
        for (const key of pending.keys()) cache.set(key, byKey.get(key) ?? -999)
      }
      const rankMs = performance.now() - rankStart
      const scored: RankedCandidate[] = entries.map(row => ({ tree: row.tree, tokens: row.tokens, comp: cache.get(row.key)! }))
      const selected = (evolveV2 ? selectPreciseIndicesQuota(scored, topK) : selectPreciseIndices(scored, topK, false)).map(index => scored[index].tokens)
      population = nextGeneration(scored, { population: cfg.population, islands, maxDepth: cfg.max_depth,
        featN: F, opOne, opTwo, v2: evolveV2, fullOps: true }, rng, gen + 1, stagnation)
      const preciseStart = performance.now()
      // No cancellation inside a generation: preserve the same boundary as
      // the desktop runners and never expose a partial precision result.
      const result = await precise(selected, gen + 1 === cfg.generations)
      champions = publicChampions(result, hello.engine_version)
      bestSeen = result.best_seen
      const researchChampions = researchGradeChampions(result.rejected_candidates)
      const preciseMs = performance.now() - preciseStart
      yield {
        seedWarning,
        generation: gen + 1, totalGenerations: cfg.generations,
        bestComposite: Math.max(-999, ...bestSeen.map(row => row.composite)), champions,
        elapsedMs: performance.now() - start, engineTag: "native-gpu-v1", engineVersion: hello.engine_version,
        actualEngine: "native-gpu", qualificationCounts: { research: result.research_candidates.length,
          qualified: champions.length, pending: result.pending_candidates.length, rejected: result.rejected_candidates.length },
        qualificationReasons: [...new Set([...result.pending_candidates, ...result.rejected_candidates].flatMap(row => row.qualification.reasons))],
        bestSeen, researchCandidates: result.research_candidates,
        nativePortfolio: result.portfolio ?? null,
        pendingCandidates: result.pending_candidates, rejectedCandidates: result.rejected_candidates,
        researchChampions,
        gpuStats: { rankMs, preciseMs, evaluated: entries.length, cacheHits: entries.length - pending.size,
          gpuEvaluated: pending.size, shardWorkers: hello.sm_count, gpuMemMB: result.gpu_buffer_mb ?? 0 },
      }
      if (cache.size > 1_000_000) cache.clear()
      if (signal.aborted) return champions
    }
    return champions
  } finally {
    await client.disposeSession(session).catch(() => undefined)
  }
}
