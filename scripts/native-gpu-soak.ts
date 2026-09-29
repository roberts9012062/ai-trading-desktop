import { FactorLabSearchRunner } from "../src/lib/mining/factor-lab-runner"
import { LocalMiningRunner } from "../src/lib/mining/local-runner"
import { putLocalTask } from "../src/lib/mining/local-store"
import { idbPut, openDb, MINING_BARS_STORE } from "../src/lib/idb"
import { maxResearchBars } from "../src/lib/device-profile"
import { fallbackRequirements, qualifyResearchCandidates } from "../src/lib/native-engine/qualification"
import { isCurrentNativeMetrics, NATIVE_ENGINE_TAG, NATIVE_ENGINE_VERSION } from "../src/lib/native-engine/version"
import type { KlineBar } from "../src/types"
import type { Champion } from "../src/lib/factor-lab-api"
import type { MiningConfig } from "../src/lib/mining/types"

/**
 * G5 长跑浏览器侧 harness(docs/plans/2026-09-29-native-gpu-m3-soak.md)。
 * 由 Python 控制器(verify-native-gpu-g5-soak.py)逐 cycle 驱动:
 * 每次 nativeSoakNext 只跑一个独立任务,避免把 8 小时挂在单次 evaluate 上,
 * 控制器每 cycle 持久化进度与采样。任何丢代/重启/降级立即抛错终止。
 */
interface SoakInput { bars: KlineBar[]; config: MiningConfig; targetMiningSeconds: number }

async function until(check: () => Promise<boolean>) {
  const start = Date.now()
  while (!await check()) {
    if (Date.now()-start > 1200000) throw new Error("soak task exceeded 20 minutes")
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}

const publish = (record: unknown) =>
  (window as unknown as { nativeSoakProgress: (record: unknown) => Promise<void> }).nativeSoakProgress(record)

let soak: {
  input: SoakInput; cycle: number; miningMs: number; miningStartMs: number; miningEndMs: number
  cycles: unknown[]; lab: FactorLabSearchRunner
} | null = null

function soakSummary() {
  if (!soak) throw new Error("soak not started")
  return { gate: "G5-soak", bars: soak.input.bars.length, guard: maxResearchBars(), engineVersion: NATIVE_ENGINE_VERSION,
    miningSeconds: soak.miningMs/1000, targetMiningSeconds: soak.input.targetMiningSeconds,
    miningStartMs: soak.miningStartMs, miningEndMs: soak.miningEndMs, cycles: soak.cycles }
}

async function runSoakCycle(): Promise<void> {
  if (!soak) throw new Error("soak not started")
  const { input } = soak
  const cycle = soak.cycle
  const entrance = cycle % 2 ? "super" : "lab"
  // New independent tasks; holdout results never affect seeds or evolution.
  const config = { ...input.config, seed: 42+cycle, seed_tokens: [],
    kernel_version: NATIVE_ENGINE_TAG, native_engine_version: NATIVE_ENGINE_VERSION }
  let lastGeneration = 0, cycleMs = 0, maxGenerationMs = 0, cycleStartMs = 0
  const miningEndMs = () => {
    soak!.miningEndMs = Date.now()
    return soak!.miningEndMs
  }
  const generation = (number: number, elapsedMs: number, restarts: number, engine: string) => {
    if (number <= lastGeneration) return
    if (number !== lastGeneration+1 || restarts !== 0 || engine !== "native-gpu") throw new Error("soak lost generation or changed engine/restart budget")
    lastGeneration = number
    cycleMs += elapsedMs; maxGenerationMs = Math.max(maxGenerationMs, elapsedMs)
    cycleStartMs ||= Date.now()-elapsedMs
    soak!.miningStartMs ||= cycleStartMs
    void publish({ type: "generation", entrance, cycle, generation: number, elapsedMs,
      miningSeconds: (soak!.miningMs+cycleMs)/1000, engine, restarts, atMs: miningEndMs() }).catch(() => undefined)
  }
  let champions: Champion[]
  if (entrance === "lab") {
    const unsubscribe = soak.lab.subscribe(task => {
      if (!task) return
      if (task.lastStep) generation(task.generation, task.lastStep.elapsedMs, task.nativeRestarts ?? 0, task.engine)
    })
    try { await soak.lab.start({ ...config, top_n: config.top_n ?? 10 }, "native-gpu") }
    finally { unsubscribe() }
    if (soak.lab.current?.status !== "completed") throw new Error(`G5 lab ${soak.lab.current?.status}: ${soak.lab.current?.error ?? soak.lab.current?.phase}`)
    champions = soak.lab.current.champions
  } else {
    const id = `native-soak-${crypto.randomUUID()}`, now = new Date().toISOString()
    const db = await openDb()
    if (!db) throw new Error("G5 IndexedDB unavailable")
    await idbPut(db, MINING_BARS_STORE, { id, symbol: config.symbol, channel: "binance_usdt", timeframe: config.timeframe,
      bars: input.bars, count: input.bars.length, from: input.bars[0].time, to: input.bars.at(-1)!.time,
      fetchedAt: Date.now(), sourceHash: "frozen-soak-fixture", refCount: 1, sizeEstimate: input.bars.length*180 })
    await putLocalTask({ id, name: "Native G5 soak", config, deviceWanted: "native-gpu", effectiveDevice: "gpu", degraded: false,
      status: "paused", current_generation: 0, progress_pct: 0, best_composite: 0, champions_count: 0,
      latest_champions: [], best_seen: [], snapshotId: id, bars_count: input.bars.length,
      data_range_from: input.bars[0].time, data_range_to: input.bars.at(-1)!.time, error_msg: null, pause_reason: null,
      elapsed_ms: 0, started_at: null, completed_at: null, created_at: now, updated_at: now })
    // #boot 在构造时一次性加载 IDB 记录:必须先落盘再构造 runner,否则任务永远不可见。
    const local = new LocalMiningRunner()
    let previousMs = 0
    const unsubscribe = local.subscribe(task => {
      if (task.id !== id) return
      if (task.current_generation > lastGeneration) {
        generation(task.current_generation, (task.elapsed_ms ?? 0)-previousMs, task.nativeRestarts ?? 0, task.actualEngine ?? "unknown")
        previousMs = task.elapsed_ms ?? 0
      }
    })
    try {
      await local.resume(id)
      await until(async () => ["completed", "failed", "paused", "cancelled"].includes((await local.get(id))!.status))
    } finally { unsubscribe() }
    const task = (await local.get(id))!
    if (task.status !== "completed") throw new Error(`G5 super ${task.status}: ${task.error_msg ?? task.pause_reason}`)
    champions = await local.champions(id)
    await local.remove(id)
  }
  if (lastGeneration !== 100) throw new Error("G5 task did not complete 100 generations")
  const qualification = champions.map(row => ({ candidate: row, requirements: fallbackRequirements(config, input.bars.length, row) }))
  for (const { candidate, requirements } of qualification) {
    const gate = qualifyResearchCandidates([candidate], requirements, true)
    if (gate.champions.length !== 1 || !isCurrentNativeMetrics(candidate.metrics as unknown as Record<string, unknown>)) throw new Error("G5 champion failed qualification or origin")
  }
  soak.miningMs += cycleMs
  const record = { type: "cycle", entrance, cycle, config, generations: lastGeneration,
    miningSeconds: cycleMs/1000, cumulativeMiningSeconds: soak.miningMs/1000, maxGenerationMs,
    startMs: cycleStartMs, endMs: soak.miningEndMs, qualification, champions: champions.length }
  soak.cycles.push(record)
  await publish(record)
}

async function nativeSoakNext(input?: SoakInput) {
  if (input) {
    if (typeof (window as unknown as { nativeSoakProgress?: unknown }).nativeSoakProgress !== "function") throw new Error("G5 requires the Python controller progress channel")
    if (input.bars.length !== 70174 || input.config.population !== 3000 || input.config.generations !== 100) throw new Error("G5 requires frozen ETH 70174 / 3000 x 100")
    soak = { input, cycle: 0, miningMs: 0, miningStartMs: 0, miningEndMs: 0, cycles: [],
      lab: new FactorLabSearchRunner({ prepareNativeBars: async () => input.bars }) }
  }
  if (!soak) throw new Error("nativeSoakNext requires input on the first call")
  if (soak.miningMs >= soak.input.targetMiningSeconds*1000) return { done: true, summary: soakSummary() }
  await runSoakCycle()
  soak.cycle += 1
  const done = soak.miningMs >= soak.input.targetMiningSeconds*1000
  return { done, summary: done ? soakSummary() : undefined }
}

Object.assign(window, { nativeSoakNext })
