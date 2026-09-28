/** Actual existing Pyodide shard pool vs native sidecar. No engine modifications. */
import { maxResearchBars } from "../src/lib/device-profile"
import { createShardPool } from "../src/lib/mining/gpu/shard-pool"
import { Rng, gpuOpSets, randomTreeGpuSafe, treeToTokens } from "../src/lib/mining/gpu/gp"
import { NativeEngineClient } from "../src/lib/native-engine/ipc"
import type { NativeEndpoint } from "../src/lib/native-engine/types"
import type { MiningConfig } from "../src/lib/mining/types"

export async function benchmarkNativeGPU(input: {
  endpoint: NativeEndpoint; bars: Array<Record<string, unknown>>; config: MiningConfig; rounds: number
}) {
  const { bars, config, endpoint } = input
  if (bars.length !== 70174 || config.population !== 3000 || config.timeframe !== "15m") {
    throw new Error("M1 acceptance requires real ETHUSDT 15m / 70174 bars / population 3000")
  }
  const stage = (value: string) => console.log(`native-benchmark-stage ${value}`)
  const client = new NativeEngineClient()
  const BaseWorker = globalThis.Worker
  // Observe the original pool's messages without modifying its implementation.
  globalThis.Worker = class extends BaseWorker {
    constructor(url: string | URL, options?: WorkerOptions) {
      super(url, options)
      this.addEventListener("message", (event) => {
        if (event.data?.type === "stage") stage(`CPU worker: ${event.data.message}`)
        if (event.data?.type === "error") stage(`CPU worker error: ${event.data.message}`)
      })
      this.addEventListener("error", (event) => stage(`CPU worker transport error: ${event.message}`))
    }
  }
  const session = crypto.randomUUID()
  let pool: Awaited<ReturnType<typeof createShardPool>> = null
  try {
    const hello = await client.connect(endpoint)
    const fields = [...new Set(bars.flatMap((bar) => Object.keys(bar).filter((key) => typeof bar[key] === "number")))]
    const columns: Record<string, Float64Array> = { time_idx: new Float64Array(bars.map((b) => new Date(String(b.time)).getTime())) }
    for (const key of fields) columns[key] = new Float64Array(bars.map((bar) => typeof bar[key] === "number" ? Number(bar[key]) : NaN))
    const maxBars = maxResearchBars()
    if (maxBars !== 100000 && maxBars !== 200000 && maxBars !== 300000) throw new Error("Invalid device-profile guard")
    await client.loadBars(session, columns, { count: bars.length, max_bars: maxBars })
    stage("preparing native PoC features")
    const feature = await client.mineFeatures(session, config)
    stage("initializing actual eight-worker CPU pool")
    pool = await createShardPool({ bars, payload: { ...config }, size: 8 })
    if (!pool || pool.size !== 8) throw new Error("Eight-worker CPU baseline unavailable; M1 cannot be certified")
    const active = feature.active_feature_ids
    const sampling = config.crypto_profile ? [...active, ...active.filter((id) => id >= 45)] : active
    const rng = new Rng(config.seed ?? 42, sampling)
    const { opOne, opTwo } = gpuOpSets(config.crypto_profile ?? false)
    const candidates = Array.from({ length: config.population }, () =>
      treeToTokens(randomTreeGpuSafe(config.max_depth, feature.feature_names.length, opOne, opTwo, rng)))
    stage("warming native kernels and CPU pool")
    await client.evalShards(session, candidates.slice(0, 128))
    await pool.evalShards(candidates.slice(0, 8))
    const rounds: Array<{ cpuMs: number; nativeMs: number; speedup: number; cpuValid: number; nativeValid: number; coverageEqual: boolean }> = []
    let cpuLast: Awaited<ReturnType<typeof pool.evalShards>> = []
    let nativeLast: Awaited<ReturnType<typeof client.evalShards>>["evaluated"] = []
    for (let i = 0; i < input.rounds; i++) {
      stage(`round ${i + 1}/${input.rounds}: CPU evaluation`)
      const startCPU = performance.now()
      cpuLast = await pool.evalShards(candidates)
      const cpuMs = performance.now() - startCPU
      stage(`round ${i + 1}/${input.rounds}: native evaluation`)
      const startGPU = performance.now()
      nativeLast = (await client.evalShards(session, candidates)).evaluated
      const nativeMs = performance.now() - startGPU
      // Compare every round and retain duplicate multiplicity. A set alone
      // could hide dropped duplicate candidates behind identical token keys.
      const keys = (rows: Array<{ tokens: number[] }>) => rows.map((entry) => JSON.stringify(entry.tokens)).sort()
      const cpuKeys = keys(cpuLast), nativeKeys = keys(nativeLast)
      const coverageEqual = cpuKeys.length === nativeKeys.length && cpuKeys.every((key, i) => key === nativeKeys[i])
      rounds.push({ cpuMs, nativeMs, speedup: cpuMs / nativeMs, cpuValid: cpuLast.length, nativeValid: nativeLast.length, coverageEqual })
      stage(JSON.stringify(rounds.at(-1)))
    }
    const coverageEqual = rounds.every((round) => round.coverageEqual)
    return { gate: "M1", hello, cpuWorkers: pool.size, bars: bars.length, trainBars: feature.train_len,
      config, rounds, candidates, cpu: cpuLast, native: nativeLast, coverageEqual,
      passed: coverageEqual && rounds.length >= 5 && rounds.every((r) => r.speedup >= 8) }
  } finally {
    pool?.dispose()
    globalThis.Worker = BaseWorker
    await client.disposeSession(session).catch(() => undefined)
    client.close()
  }
}
