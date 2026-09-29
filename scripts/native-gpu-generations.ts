/** M2 core G3: unchanged JS evolution, real IPC, GPU authority and precise. */
import { maxResearchBars } from "../src/lib/device-profile"
import { Rng, gpuOpSets, randomTreeGpuSafe, treeToTokens, type Tree } from "../src/lib/mining/gpu/gp"
import { nextGeneration, resolveIslands } from "../src/lib/mining/gpu/evolve"
import { preciseTopK, selectPreciseIndices, type RankedCandidate } from "../src/lib/mining/gpu/rank"
import { NativeEngineClient } from "../src/lib/native-engine/ipc"
import type { NativeEndpoint, NativeEvaluatedCandidate, NativeChampion, NativePreciseResult } from "../src/lib/native-engine/types"
import type { MiningConfig } from "../src/lib/mining/types"

export async function benchmarkNativeGenerations(input: {
  endpoint: NativeEndpoint; bars: Array<Record<string, unknown>>; config: MiningConfig
}) {
  const { bars, config, endpoint } = input
  if (bars.length !== 70174 || config.population !== 3000 || config.timeframe !== "15m" ||
      config.symbol?.toUpperCase() !== "ETHUSDT" || config.evolve_v2) {
    throw new Error("G3 core requires ETHUSDT 15m / 70174 bars / population 3000 / original evolution")
  }
  const stage = (message: string) => console.log(`native-generation-stage ${message}`)
  const client = new NativeEngineClient({ onStage: stage })
  const session = crypto.randomUUID()
  try {
    const hello = await client.connect(endpoint)
    const fields = [...new Set(bars.flatMap(bar => Object.keys(bar).filter(key => typeof bar[key] === "number")))]
    const columns: Record<string, Float64Array> = {
      time_idx: new Float64Array(bars.map(bar => new Date(String(bar.time)).getTime())),
    }
    for (const key of fields) columns[key] = new Float64Array(bars.map(bar =>
      typeof bar[key] === "number" ? Number(bar[key]) : NaN))
    const strings: Record<string, Array<string | null>> = {}
    for (const key of ["time", "market_source", "_factor_market"]) {
      if (bars.some(bar => typeof bar[key] === "string")) {
        strings[key] = bars.map(bar => typeof bar[key] === "string" ? String(bar[key]) : null)
      }
    }
    const limit = maxResearchBars()
    if (limit !== 100000 && limit !== 200000 && limit !== 300000) throw new Error("Invalid device-profile guard")
    await client.loadBars(session, columns, { count: bars.length, max_bars: limit, string_columns: strings })
    const feature = await client.mineFeatures(session, config)
    if (feature.features_source !== "gpu-taichi") throw new Error("G3 requires GPU features")
    const F = feature.feature_names.length
    const active = feature.active_feature_ids
    const sampling = config.crypto_profile ? [...active, ...active.filter(id => id >= 45)] : active
    const rng = new Rng(config.seed ?? 42, sampling)
    const { opOne, opTwo } = gpuOpSets(config.crypto_profile ?? false)
    const islands = resolveIslands(config.population, config.islands)
    let population: Tree[] = Array.from({ length: config.population }, () =>
      randomTreeGpuSafe(config.max_depth, F, opOne, opTwo, rng))
    const initialCandidates = population.map(treeToTokens)
    // Compile session-specific training kernels before measured mining. G1
    // already warms the shared VM/report programs. Warmup does not feed archives.
    await client.evalShards(session, initialCandidates.slice(0, 8))
    if (hello.precision === "mixed") await client.rankShards(session, initialCandidates.slice(0, 8))
    const rankCache = new Map<string, number>()
    let bestSeen: NativeEvaluatedCandidate[] = []
    let champions: NativeChampion[] = []
    let finalResult: NativePreciseResult | undefined
    const generations = []
    const topK = preciseTopK(config.population, config.top_n ?? 10, feature.train_len)
    const miningStartMs = Date.now()
    for (let gen = 0; gen < config.generations; gen++) {
      const startMs = Date.now(), start = performance.now()
      const entries = population.map(tree => {
        const tokens = treeToTokens(tree)
        return { tree, tokens, key: tokens.join(",") }
      })
      const pending = new Map<string, number[]>()
      for (const entry of entries) if (!rankCache.has(entry.key)) pending.set(entry.key, entry.tokens)
      const rankStart = performance.now()
      if (pending.size) {
        const tokens = [...pending.values()]
        const scores = hello.precision === "mixed"
          ? (await client.rankShards(session, tokens)).ranked.map(row => ({ tokens: row.tokens, score: row.score }))
          : (await client.evalShards(session, tokens)).evaluated.map(row => ({ tokens: row.tokens, score: row.composite }))
        const fresh = new Map(scores.map(row => [row.tokens.join(","), row.score]))
        for (const key of pending.keys()) rankCache.set(key, fresh.get(key) ?? -999)
      }
      const rankMs = performance.now() - rankStart
      const scored: RankedCandidate[] = entries.map(entry => ({
        tree: entry.tree, tokens: entry.tokens, comp: rankCache.get(entry.key)!,
      }))
      const selected = selectPreciseIndices(scored, topK, false).map(i => scored[i].tokens)
      const evolveStart = performance.now()
      population = nextGeneration(scored, { population: config.population, islands,
        maxDepth: config.max_depth, featN: F, opOne, opTwo, v2: false }, rng, gen + 1)
      const evolveMs = performance.now() - evolveStart
      const preciseStart = performance.now()
      const evaluated = (await client.evalShards(session, selected)).evaluated
      const authorityMs = performance.now() - preciseStart
      const head = new Map<string, NativeEvaluatedCandidate>()
      for (const entry of [...bestSeen, ...evaluated]) {
        const key = entry.tokens.join(","), old = head.get(key)
        if (!old || entry.composite > old.composite) head.set(key, entry)
      }
      const strictTokens = [...head.values()].sort((a, b) => b.composite - a.composite)
        .slice(0, 60).map(entry => entry.tokens)
      const strictStart = performance.now()
      const { strict } = await client.strictEval(session, strictTokens)
      const strictMs = performance.now() - strictStart
      const enrichmentStart = performance.now()
      const result = await client.precise(session, { evaluated, best_seen: bestSeen,
        prefetched_strict: strict, trials: config.population * config.generations,
        final_generation: gen + 1 === config.generations })
      bestSeen = result.best_seen
      champions = result.champions
      finalResult = result
      const preciseMs = performance.now() - preciseStart
      const enrichmentMs = performance.now() - enrichmentStart
      const record = { generation: gen + 1, startMs, endMs: Date.now(),
        elapsedMs: performance.now() - start, rankMs, evolveMs, preciseMs, authorityMs, strictMs, enrichmentMs,
        gpuEvaluated: pending.size, cacheHits: entries.length - pending.size,
        champions: champions.length, bestComposite: Math.max(-999, ...champions.map(c => c.composite)) }
      Object.assign(record, { researchCandidates: result.research_candidates.length,
        pendingCandidates: result.pending_candidates.length, rejectedCandidates: result.rejected_candidates.length })
      generations.push(record)
      stage(JSON.stringify(record))
      if (rankCache.size > 1_000_000) rankCache.clear()
    }
    return { gate: "G3", hello, config, bars: bars.length, trainBars: feature.train_len,
      miningStartMs, miningEndMs: Date.now(), initialCandidates, generations, champions, best_seen: bestSeen,
      research_candidates: finalResult?.research_candidates, pending_candidates: finalResult?.pending_candidates,
      rejected_candidates: finalResult?.rejected_candidates, qualification_requirements: finalResult?.qualification_requirements }
  } finally {
    await client.disposeSession(session).catch(() => undefined)
    client.close()
  }
}
