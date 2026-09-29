import { FactorLabSearchRunner } from "../src/lib/mining/factor-lab-runner"
import { LocalMiningRunner } from "../src/lib/mining/local-runner"
import { putLocalTask } from "../src/lib/mining/local-store"
import { idbPut, openDb, MINING_BARS_STORE } from "../src/lib/idb"
import type { KlineBar } from "../src/types"
import type { MiningConfig } from "../src/lib/mining/types"
import { NATIVE_ENGINE_TAG, NATIVE_ENGINE_VERSION } from "../src/lib/native-engine/version"

async function until(check: () => boolean | Promise<boolean>, timeout = 1200000) {
  const started = performance.now()
  while (!await check()) {
    if (performance.now()-started > timeout) throw new Error("native runner verification timed out")
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}
interface Input { bars: KlineBar[]; config: MiningConfig; mode: "complete" | "kill" | "fallback" | "driver" | "queue" }
async function nativeRunnerVerification(input: Input) {
  const results = []
  const config = { ...input.config, generations: input.mode === "kill" ? 6 : 3,
    kernel_version: NATIVE_ENGINE_TAG, native_engine_version: NATIVE_ENGINE_VERSION }
  const controller = window as unknown as { nativeTestFault?: (request: { entrance: string; generation: number }) => Promise<void> }
  let labKills = 0
  const lab = new FactorLabSearchRunner({ prepareNativeBars: async () => input.bars })
  const labEvents: unknown[] = []
  lab.subscribe(task => {
    if (!task) return
    labEvents.push(structuredClone(task))
    if ((input.mode === "kill" || input.mode === "driver") && task.status === "running" && task.engine === "native-gpu" && task.generation > labKills && labKills < (input.mode === "driver" ? 1 : 4)) {
      labKills++; void controller.nativeTestFault?.({ entrance: "lab", generation: task.generation })
    }
  })
  await lab.start({ ...config, top_n: config.top_n ?? 10, seed: config.seed ?? 42 }, "native-gpu")
  if (input.mode === "kill") {
    if (lab.current?.status !== "paused" || lab.current.nativeRestarts !== 3 || labKills !== 4) throw new Error("lab did not preserve exhausted D-1 checkpoint")
    const before = lab.current.generation
    await lab.resume()
    if (String(lab.current?.status) !== "completed" || before < 1) throw new Error("lab manual resume failed")
  }
  results.push({ entrance: "lab", kills: labKills, task: structuredClone(lab.current), events: labEvents })

  // Real IndexedDB/snapshot read and default LocalMiningRunner factory. Frozen
  // fixture acquisition is test setup; it never fetches a different bar range.
  const id = `native-verification-${crypto.randomUUID()}`, now = new Date().toISOString()
  const db = await openDb()
  if (!db) throw new Error("verification IndexedDB unavailable")
  await idbPut(db, MINING_BARS_STORE, { id, symbol: config.symbol, channel: "binance_usdt", timeframe: config.timeframe,
    bars: input.bars, count: input.bars.length, from: input.bars[0].time, to: input.bars.at(-1)!.time,
    fetchedAt: Date.now(), sourceHash: "frozen-python-verified-fixture", refCount: 1, sizeEstimate: input.bars.length*180 })
  await putLocalTask({ id, name: "Native runner verification", config, deviceWanted: "native-gpu", effectiveDevice: "gpu",
    degraded: false, status: "paused", current_generation: 0, progress_pct: 0, best_composite: 0, champions_count: 0,
    latest_champions: [], best_seen: [], snapshotId: id, bars_count: input.bars.length,
    data_range_from: input.bars[0].time, data_range_to: input.bars.at(-1)!.time, error_msg: null, pause_reason: null,
    elapsed_ms: 0, started_at: null, completed_at: null, created_at: now, updated_at: now })
  const runner = new LocalMiningRunner(), superEvents: unknown[] = []
  let superKills = 0
  runner.subscribe(task => {
    if (task.id !== id) return
    superEvents.push(structuredClone(task))
    if ((input.mode === "kill" || input.mode === "driver") && task.status === "running" && task.actualEngine === "native-gpu" && task.current_generation > superKills && superKills < (input.mode === "driver" ? 1 : 4)) {
      superKills++; void controller.nativeTestFault?.({ entrance: "super", generation: task.current_generation })
    }
  })
  await runner.resume(id)
  await until(async () => { const task = (await runner.get(id))!; return task.status === "completed" || task.status === "failed" || (task.status === "paused" && task.nativeRestarts === 3) })
  if (input.mode === "kill") {
    const task = await runner.get(id)
    if (task?.status !== "paused" || task.nativeRestarts !== 3 || superKills !== 4) throw new Error("super factor did not persist exhausted checkpoint")
    await runner.resume(id)
    await until(async () => (await runner.get(id))!.status === "completed" || (await runner.get(id))!.status === "failed")
  }
  results.push({ entrance: "super", kills: superKills, task: await runner.get(id), events: superEvents,
    champions: await runner.champions(id) })
  return { gate: "M3-runners", results, passed: results.every(row => row.task?.status === "completed") }
}

/** M3-B real shared-queue check: two entrances in one page, one resident process. */
interface QueueInput { bars: KlineBar[]; config: MiningConfig }
async function nativeQueueVerification(input: QueueInput) {
  const stats = async () => await (window as unknown as { nativeTestStats?: () => Promise<{ starts: number }> }).nativeTestStats?.()
  const config = { ...input.config, generations: 3, kernel_version: NATIVE_ENGINE_TAG, native_engine_version: NATIVE_ENGINE_VERSION }
  const lab = new FactorLabSearchRunner({ prepareNativeBars: async () => input.bars })
  let labGenerations = new Set<number>()
  const onLab = (task: Parameters<Parameters<typeof lab.subscribe>[0]>[0]) => {
    // 每个 patch 都带 lastStep:按代数去重,事件数不等于代数;C 阶段重置集合。
    if (task?.lastStep && task.status === "running") labGenerations.add(task.generation)
  }
  lab.subscribe(onLab)
  // A (lab, mixed) holds the resident process; only start B after A truly mines.
  const aPromise = lab.start({ ...config, top_n: config.top_n ?? 10, seed: 101 }, "native-gpu")
  await until(() => (lab.current?.generation ?? 0) >= 1)

  // B (super, same mixed precision) must FIFO-queue behind A without touching it.
  const id = `native-queue-${crypto.randomUUID()}`, now = new Date().toISOString()
  const db = await openDb()
  if (!db) throw new Error("verification IndexedDB unavailable")
  await idbPut(db, MINING_BARS_STORE, { id, symbol: config.symbol, channel: "binance_usdt", timeframe: config.timeframe,
    bars: input.bars, count: input.bars.length, from: input.bars[0].time, to: input.bars.at(-1)!.time,
    fetchedAt: Date.now(), sourceHash: "frozen-python-verified-fixture", refCount: 1, sizeEstimate: input.bars.length*180 })
  await putLocalTask({ id, name: "Native queue verification", config, deviceWanted: "native-gpu", effectiveDevice: "gpu",
    degraded: false, status: "paused", current_generation: 0, progress_pct: 0, best_composite: 0, champions_count: 0,
    latest_champions: [], best_seen: [], snapshotId: id, bars_count: input.bars.length,
    data_range_from: input.bars[0].time, data_range_to: input.bars.at(-1)!.time, error_msg: null, pause_reason: null,
    elapsed_ms: 0, started_at: null, completed_at: null, created_at: now, updated_at: now })
  const local = new LocalMiningRunner()
  const superEvents: unknown[] = []
  let superGens = 0
  local.subscribe(task => { if (task?.id === id) { superEvents.push(structuredClone(task)); if (task.current_generation > superGens) superGens = task.current_generation } })
  await local.resume(id)
  await until(async () => (await local.get(id))?.status === "running")
  // A keeps mining while B waits: A reaches a later generation with B still at 0.
  await until(() => (lab.current?.generation ?? 0) >= 2)
  const bQueuedZeroGens = (await local.get(id))!.current_generation === 0
  const startsWhileShared = (await stats())?.starts
  await local.cancel(id)
  const bCancelled = (await local.get(id))!.status === "cancelled"
  await aPromise
  const aCompleted = lab.current?.status === "completed" && lab.current.generation === 3
  const aGens = labGenerations.size
  labGenerations = new Set()
  const startsAfterACancelB = (await stats())?.starts

  // C (lab, f64) switches precision only while the queue is idle: one stop+respawn.
  await lab.start({ ...config, top_n: config.top_n ?? 10, seed: 202, native_precision: "f64" }, "native-gpu")
  const cCompleted = lab.current?.status === "completed" && lab.current.generation === 3
  const cGens = labGenerations.size
  const startsFinal = (await stats())?.starts
  const passed = bQueuedZeroGens && bCancelled && aCompleted && cCompleted && cGens === 3
    && startsWhileShared === 1 && startsAfterACancelB === 1 && startsFinal === 2
  return { gate: "M3-queue", passed, bQueuedZeroGens, bCancelled, aCompleted, cCompleted, aGens, cGens,
    startsWhileShared, startsAfterACancelB, startsFinal, superEvents,
    commandAdapterNote: "shared FIFO lease across both entrances in one page" }
}
Object.assign(window, { nativeRunnerVerification, nativeQueueVerification })
