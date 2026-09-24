/**
 * GpuBackend —— WebGPU 粗排 + Pyodide f64 精算(M4)
 *
 * 分工(文档 2.8,硬约束):
 * - 树的生成/交叉/变异/锦标赛:JS;
 * - 因子求值 + 适应度粗排:WGSL(f32)——GPU 数字只用于排序;
 * - 每代 top-K(top_n×3)的精算、_dedup_top/严格筛/walk-forward、最终
 *   champions 的全部指标:Pyodide 内核(f64)——对外暴露的数字全部出自这里,
 *   本地/服务端同源不被破坏;
 * - EMA 不支持:GP 生成时排除;历史种子含 EMA → 精算入口自然处理
 *   (内核对不支持的语义没有依赖,GPU 侧判 -999 不参与粗排)。
 *
 * 掉设备(device.lost):转抛错误 → local-runner 有进度任务自动转 paused,
 * 恢复时重新申请设备、以历史最优为种子从当前代继续(D-1 语义)。
 */

import type { Champion } from "@/lib/factor-lab-api"
import { ensurePyWorker } from "@/lib/py-worker"
import { getBarsSnapshot } from "../data-source"
import type {
  ComputeBackend,
  EvalRequest,
  GenerationStep,
  SerializedBest,
} from "./types"
import { acquireGpuDevice, probeGpu } from "../device"
import { createGpuEval, disposeGpuEval, type GpuEvalSetup } from "../gpu/eval-gpu"
import { nextRet } from "../gpu/eval-core"
import {
  createRankCache,
  preciseTopK,
  rankPopulation,
  selectPreciseIndices,
  type RankOutcome,
  type RankedCandidate,
} from "../gpu/rank"
import {
  Rng,
  gpuOpSets,
  randomTreeGpuSafe,
  tokensToTree,
  type Tree,
} from "../gpu/gp"
import { StagnationTracker, nextGeneration, resolveIslands } from "../gpu/evolve"

interface MineFeaturesResult {
  feature_names: string[]
  matrix: number[][]
  periods: number
  cost: number
  train_len: number
  total_len: number
}

interface MinePreciseResult {
  champions: Champion[]
  best_seen: SerializedBest[]
}

export class GpuBackend implements ComputeBackend {
  readonly device = "gpu" as const

  async probe(): Promise<{ available: boolean; reason?: string; detail?: string }> {
    return probeGpu()
  }

  async *run(
    req: EvalRequest,
    signal: AbortSignal,
  ): AsyncGenerator<GenerationStep, Champion[], void> {
    const snapshot = await getBarsSnapshot(req.snapshotId)
    if (!snapshot) {
      throw new Error("K 线快照不存在或已被清理,请删除任务后重新创建")
    }
    if (signal.aborted) return []
    const final: Champion[] = yield* this.runDirect(snapshot.bars, req, signal)
    return final
  }

  /** 直接给定 bars 的入口(因子实验室快速搜索已有 bars,无需 IDB 快照) */
  async *runDirect(
    bars: { close?: number }[],
    req: EvalRequest,
    signal: AbortSignal,
  ): AsyncGenerator<GenerationStep, Champion[], void> {
    if (signal.aborted) return []
    const sessionId = crypto.randomUUID()
    try {
      return yield* this.runSession(bars, req, signal, sessionId)
    } finally {
      await ensurePyWorker().factorRun(
        { mode: "mine_gpu_dispose", gpu_session_id: sessionId }, [], 10_000,
      ).catch(() => undefined)
    }
  }

  private async *runSession(
    bars: { close?: number }[],
    req: EvalRequest,
    signal: AbortSignal,
    sessionId: string,
  ): AsyncGenerator<GenerationStep, Champion[], void> {
    const cfg = req.config
    if (signal.aborted) return []

    // 1) 特征/年化基数/成本率一律由内核产出(GPU 不重算特征,避免第三套口径)
    const py = ensurePyWorker()
    const features = (await py.factorRun(
      {
        mode: "mine_features",
        gpu_session_id: sessionId,
        symbol: cfg.symbol,
        timeframe: cfg.timeframe,
        train_ratio: cfg.train_ratio,
        ...(cfg.test_recent_bars != null ? { test_recent_bars: cfg.test_recent_bars } : {}),
        cost: cfg.cost ?? null,
      },
      bars as unknown,
      120_000,
    )) as MineFeaturesResult

    const F = features.feature_names.length
    const T = features.train_len
    const featFlat = new Float32Array(F * T)
    for (let f = 0; f < F; f++) {
      const row = features.matrix[f]
      for (let t = 0; t < T; t++) featFlat[f * T + t] = row[t]
    }
    const trainCloses: number[] = []
    for (let i = 0; i < T && i < bars.length; i++) {
      trainCloses.push(Number(bars[i].close ?? 0))
    }
    const ret = nextRet(trainCloses)
    const retF32 = new Float32Array(T)
    for (let t = 0; t < T; t++) retF32[t] = ret[t]

    // 2) GPU 设备 + 求值上下文
    let lostReason: string | null = null
    const gpuDevice = await acquireGpuDevice((reason) => {
      lostReason = reason
    })
    let setup: GpuEvalSetup | null = null
    let prefetched: Promise<{ outcome?: RankOutcome; error?: unknown }> | null = null
    let lastChampions: Champion[] = []
    let bestSeen: SerializedBest[] = req.seedBest ? [...req.seedBest] : []

    try {
      setup = await createGpuEval(gpuDevice, featFlat, retF32, {
        F,
        T,
        periods: features.periods,
        cost: features.cost,
        population: cfg.population,
      })

      // 3) 精算入口(每代 top-K 与历史种子都走这里,f64 权威口径)。
      //    粗排只定漏斗名单,名单内全部由内核 f64 重算(GPU 数字只用于
      //    排序,绝不出数);漏斗宽度由 preciseTopK 按训练段长度钳住。
      const precise = async (candidates: number[][]): Promise<MinePreciseResult> =>
        (await py.factorRun(
          {
            mode: "mine_precise",
            gpu_session_id: sessionId,
            symbol: cfg.symbol,
            timeframe: cfg.timeframe,
            population: cfg.population,
            generations: cfg.generations,
            max_depth: cfg.max_depth,
            train_ratio: cfg.train_ratio,
            ...(cfg.test_recent_bars != null ? { test_recent_bars: cfg.test_recent_bars } : {}),
            walk_forward_folds: cfg.walk_forward_folds,
            top_n: cfg.top_n ?? 10,
            cost: cfg.cost ?? null,
            candidates,
            best_seen: bestSeen,
            trials: cfg.population * cfg.generations,
            // 跨品种验证:JS 预加载的同板块伙伴 bars(_dedup_top 严格筛消费)
            ...(cfg.cross_peers?.length ? { cross_peers: cfg.cross_peers } : {}),
            // 本地增强遴选/实盘离散口径门(内核 SearchConfig 字段,默认关)
            ...(cfg.selection_v2 ? { selection_v2: true } : {}),
            ...(cfg.live_entry_gate ? { live_entry_gate: cfg.live_entry_gate } : {}),
          },
          [],
          600_000,
        )) as MinePreciseResult

      // 4) GP 初始化(仅 GPU 支持的算子;种子注入种群,与 stepwise 同构)
      const islands = resolveIslands(cfg.population, cfg.islands)
      const rng = new Rng((cfg.seed ?? 42) + req.startGeneration)
      const { opOne, opTwo } = gpuOpSets()
      const maxDepth = cfg.max_depth
      const population: Tree[] = []
      for (let i = 0; i < cfg.population; i++) {
        population.push(randomTreeGpuSafe(maxDepth, F, opOne, opTwo, rng))
      }
      const seedTokens = cfg.seed_tokens ?? []
      for (let k = 0; k < seedTokens.length && k < population.length; k++) {
        const tree = tokensToTree(seedTokens[k], F)
        if (tree) population[k] = tree // 含不支持算子的种子留待精算(GPU 判 -999)
      }

      // 历史种子(断点续训/显式种子)先精算一次:注入 best_seen,保证不倒退
      if (bestSeen.length > 0 || seedTokens.length > 0) {
        const init = await precise(seedTokens)
        bestSeen = init.best_seen
        lastChampions = init.champions
      }

      // 5) 分代主循环(粗排[任务级缓存] → 遗传 → 精算 → yield)
      // 漏斗宽度按训练段长度钳住:漏斗内每条都由内核 f64 重算
      const topK = preciseTopK(cfg.population, cfg.top_n ?? 10, T)
      const cache = createRankCache()
      // 进化增强:繁殖排序键/停滞重启 + 精算名单按行为指纹去重
      const evolveV2 = cfg.evolve_v2 === true
      const stagnation = evolveV2 ? new StagnationTracker(islands) : undefined
      for (let genIdx = req.startGeneration; genIdx < cfg.generations; genIdx++) {
        if (signal.aborted) return lastChampions
        if (lostReason !== null) {
          throw new Error(`WebGPU 设备丢失(${lostReason}),已中止;恢复时将从当前代继续`)
        }
        const t0 = Date.now()

        const scored: RankedCandidate[] = []
        let rankStats: { gpuEvaluated: number; cacheHits: number; gpuMs: number } = {
          gpuEvaluated: 0, cacheHits: 0, gpuMs: 0,
        }
        {
          const ready = prefetched ? await prefetched : null
          prefetched = null
          if (ready?.error) throw ready.error
          const outcome = ready?.outcome ?? await rankPopulation(setup, cache, population)
          scored.push(...outcome.ranked)
          rankStats = outcome.stats
        }

        // 粗排 top-K → 内核精算(名单内全部 f64 重算;权威 champions + best_seen 传递)
        const topCandidates = selectPreciseIndices(scored, topK, evolveV2).map(
          (i) => scored[i].tokens,
        )

        // 下一代:岛模型进化(每岛精英+锦标赛+交叉/变异,每 5 代环状迁移;
        // islands=1 退化为原单种群行为)
        const nextTrees = nextGeneration(
          scored,
          { population: cfg.population, islands, maxDepth, featN: F, opOne, opTwo, v2: evolveV2 },
          rng,
          genIdx + 1,
          stagnation,
        )
        population.splice(0, population.length, ...nextTrees)

        // Evolution depends only on coarse scores, never on precise champions.
        // Queue one generation ahead while the f64 worker validates this one.
        if (genIdx + 1 < cfg.generations && !signal.aborted) {
          prefetched = rankPopulation(setup, cache, population).then(
            (outcome) => ({ outcome }),
            (error: unknown) => ({ error }),
          )
        }
        const preciseStart = performance.now()
        if (topCandidates.length > 0) {
          const result = await precise(topCandidates)
          bestSeen = result.best_seen
          lastChampions = result.champions
        }
        const preciseMs = performance.now() - preciseStart

        const bestComposite = lastChampions.reduce(
          (m, c) => Math.max(m, c.composite),
          -999,
        )
        yield {
          generation: genIdx + 1,
          totalGenerations: cfg.generations,
          bestComposite,
          champions: lastChampions,
          elapsedMs: Date.now() - t0,
          // GPU 活动面板数据:粗排吞吐/缓存/显存估算/精算并行度
          gpuStats: {
            rankMs: Math.round(rankStats.gpuMs),
            evaluated: population.length,
            cacheHits: rankStats.cacheHits,
            gpuEvaluated: rankStats.gpuEvaluated,
            preciseMs: Math.round(preciseMs),
            gpuMemMB: Math.round(setup.bufferBytes / 1048576),
            // 评估已并入 GPU 粗排,精算 = 内核对 shortlist 头部的 f64 验证
            shardWorkers: 0,
          },
        }
        if (signal.aborted) return lastChampions
      }
      return lastChampions
    } finally {
      // A cancelled generator may still own a speculative readback.
      if (prefetched) await prefetched
      if (setup) disposeGpuEval(setup)
      gpuDevice.destroy()
    }
  }

  async dispose(): Promise<void> {
    // 设备与批缓冲在 run() 的 finally 中释放
  }
}
