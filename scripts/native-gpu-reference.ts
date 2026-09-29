/** Full G2 reference through the unchanged production Pyodide worker/pool. */
import { ensurePyWorker, cancelPyWorker } from "../src/lib/py-worker"
import { createShardPool } from "../src/lib/mining/gpu/shard-pool"
import { Rng, gpuOpSets, randomTreeGpuSafe, treeToTokens } from "../src/lib/mining/gpu/gp"
import type { MiningConfig } from "../src/lib/mining/types"

export async function nativeGPUReference(input: {
  bars: Array<Record<string, unknown>>; config: MiningConfig; candidates?: number[][]
}) {
  const { bars, config } = input
  if (bars.length > 100000 || bars.length < 2) throw new Error("G2 device guard exceeded")
  const stage = (message: string) => console.log(`native-reference-stage ${message}`)
  cancelPyWorker()
  const py = ensurePyWorker()
  const session = crypto.randomUUID()
  let pool: Awaited<ReturnType<typeof createShardPool>> = null
  try {
    stage("CPU feature preparation")
    const feature = await py.factorRun({ ...config, mode: "mine_features", gpu_session_id: session }, bars) as {
      active_feature_ids: number[]; feature_names: string[]; train_len: number
    }
    const rng = new Rng(config.seed ?? 42, feature.active_feature_ids)
    const { opOne, opTwo } = gpuOpSets(config.crypto_profile ?? false)
    // Include every supported VM operator and the two frozen M1 regressions.
    // All candidates, including duplicates/invalid/constant, go through eval.
    const supported = Array.from({ length: 51 }, (_, op) => op).filter(op => ![38, 39, 44, 45].includes(op))
    const binary = new Set([0, 1, 2, 3, 4, 5, 29, 35, 36])
    const candidates = input.candidates ?? [
      ...feature.active_feature_ids.map(id => [id]),
      ...supported.map(op => binary.has(op) ? [0, 1, op + 64] : [0, op + 64]),
      [51, 75, 40, 67, 113, 87, 112, 51, 94, 71, 91, 67], [59, 104, 111, 74, 96],
      [0], [0], [0, 0, 65], [], [64],
      ...Array.from({ length: 1000 }, () => treeToTokens(randomTreeGpuSafe(
        config.max_depth, feature.feature_names.length, opOne, opTwo, rng))),
    ]
    stage("Eight CPU workers")
    pool = await createShardPool({ bars, payload: { ...config }, size: 8 })
    if (!pool || pool.size !== 8) throw new Error("Original eight-worker pool unavailable")
    stage("CPU authoritative training evaluation")
    const evaluated = await pool.evalShards(candidates)
    const seen = new Set<string>()
    const strictCandidates = [...evaluated].sort((a, b) => b.composite - a.composite)
      .filter(item => { const key = JSON.stringify(item.tokens); if (seen.has(key)) return false; seen.add(key); return true })
      .slice(0, Math.max(60, (config.top_n ?? 10) * 3)).map(item => item.tokens)
    if (!strictCandidates.length) throw new Error("Empty CPU reference population")
    stage("CPU strict shard prefetch")
    const strict = await pool.evalStrict(strictCandidates)
    stage("CPU main worker precise and sealed holdout")
    const precisePayload = { evaluated, best_seen: [], prefetched_strict: strict,
      trials: config.population * config.generations, final_generation: true }
    const precise = await py.factorRun({ ...config, ...precisePayload, mode: "mine_precise", gpu_session_id: session }, []) as {
      champions: Array<{ tokens: number[]; composite: number; metrics: Record<string, unknown> }>
      best_seen: Array<{ tokens: number[]; composite: number; metrics: Record<string, unknown> }>
    }
    return { candidates, strict_candidates: strictCandidates, precise_payload: {
      trials: precisePayload.trials, final_generation: true },
      outputs: { evaluated, strict, champions: precise.champions, best_seen: precise.best_seen },
      cpu_workers: pool.size, train_len: feature.train_len }
  } finally {
    pool?.dispose()
    cancelPyWorker()
  }
}
