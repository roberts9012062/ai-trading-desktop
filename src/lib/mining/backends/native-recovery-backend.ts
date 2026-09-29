import type { Champion } from "@/lib/factor-lab-api"
import type { KlineBar } from "@/types"
import { getBarsSnapshot } from "../data-source"
import { NativeGpuBackend, type NativeGpuBackendOptions } from "./native-gpu-backend"
import type { ComputeBackend, EvalRequest, GenerationStep } from "./types"
import type { NativeBar } from "@/lib/native-engine/bars"
import { runNativeRecovery, type DirectBackend, type NativeActualEngine, type NativeRecoveryState } from "@/lib/native-engine/recovery"

export interface NativeRecoveryBackendOptions extends NativeGpuBackendOptions {
  onRecovery?: (state: NativeRecoveryState) => void | Promise<void>
  createBackend?: (engine: NativeActualEngine) => Promise<DirectBackend>
}
/** Native entry with the approved old-engine fallback policy. */
export class NativeRecoveryBackend implements ComputeBackend {
  readonly device = "gpu" as const
  #controller = new AbortController()
  #runs = new Map<AsyncGenerator<GenerationStep, Champion[], void>, () => void>()
  constructor(private options: NativeRecoveryBackendOptions = {}) {}
  setRecoveryHandler(handler: NonNullable<NativeRecoveryBackendOptions["onRecovery"]>) { this.options.onRecovery = handler }
  setStageHandler(handler: NonNullable<NativeRecoveryBackendOptions["onStage"]>) { this.options.onStage = handler }
  async probe() { return new NativeGpuBackend(this.options).probe() }
  async *run(req: EvalRequest, signal: AbortSignal): AsyncGenerator<GenerationStep, Champion[], void> {
    const snapshot = await getBarsSnapshot(req.snapshotId)
    if (!snapshot) throw new Error("K 线快照不存在或已被清理，请删除任务后重新创建")
    return yield* this.runDirect(snapshot.bars, req, signal)
  }
  runDirect(bars: NativeBar[], req: EvalRequest, signal: AbortSignal) {
    const controller = new AbortController()
    const abort = () => controller.abort()
    if (signal.aborted || this.#controller.signal.aborted) controller.abort()
    signal.addEventListener("abort", abort, { once: true })
    this.#controller.signal.addEventListener("abort", abort, { once: true })
    const create = this.options.createBackend ?? (async engine => {
      if (engine === "native-gpu") return new NativeGpuBackend(this.options)
      const backend = engine === "gpu" ? new (await import("./gpu-backend")).GpuBackend()
        : new (await import("./cpu-backend")).CpuBackend()
      return { runDirect: (rows: NativeBar[], request: EvalRequest, cancel: AbortSignal) =>
        backend.runDirect(rows as KlineBar[], request, cancel), dispose: () => backend.dispose() }
    })
    const cleanup = () => {
      signal.removeEventListener("abort", abort)
      this.#controller.signal.removeEventListener("abort", abort)
      this.#runs.delete(gen)
    }
    const gen = (async function* (options: NativeRecoveryBackendOptions) {
      try { return yield* runNativeRecovery(bars, req, controller.signal, create, options.onRecovery) }
      finally { cleanup() }
    })(this.options)
    this.#runs.set(gen, cleanup)
    return gen
  }
  async dispose() {
    this.#controller.abort()
    const runs = [...this.#runs.entries()]
    await Promise.allSettled(runs.map(([gen]) => gen.return([])))
    for (const [, cleanup] of runs) cleanup()
    this.#runs.clear()
  }
}
