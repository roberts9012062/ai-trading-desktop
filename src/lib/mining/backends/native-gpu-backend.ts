import type { Champion } from "@/lib/factor-lab-api"
import { getBarsSnapshot } from "../data-source"
import { NativeEngineClient, NativeEngineError } from "@/lib/native-engine/ipc"
import { probeQueuedNative } from "@/lib/native-engine/use-native-availability"
import { nativeProcessQueue, type NativeProcessLease } from "@/lib/native-engine/process-lease"
import { nativeProcessLost, nativeUnavailable } from "@/lib/native-engine/recovery"
import { nativeStageLabel } from "@/lib/native-engine/progress"
import type { NativeEndpoint, NativePrecision } from "@/lib/native-engine/types"
import type { NativeBar } from "@/lib/native-engine/bars"
import type { ComputeBackend, EvalRequest } from "./types"
import { runNativeGpuSession, type NativeGenerationStep, type NativeSessionClient } from "./native-gpu-core"

type ConnectedClient = NativeSessionClient & Pick<NativeEngineClient, "connect" | "close">
type NativeRunGenerator = AsyncGenerator<NativeGenerationStep, Champion[], void>
interface OwnedRun { controller: AbortController; generator?: NativeRunGenerator; cleanup: () => void }
export interface NativeGpuBackendOptions {
  precision?: NativePrecision
  onStage?: (message: string) => void
  createClient?: () => ConnectedClient
  launch?: (options: { precision: NativePrecision }) => Promise<NativeEndpoint>
}

/** Shared numerical backend for the lab and super-factor entry points. */
export class NativeGpuBackend implements ComputeBackend {
  readonly device = "gpu" as const
  readonly engineTag = "native-gpu-v1" as const
  #options: NativeGpuBackendOptions
  #runs = new Set<OwnedRun>()
  #disposed = false

  constructor(options: NativeGpuBackendOptions = {}) { this.#options = options }

  async probe() { return probeQueuedNative(this.#options.precision) }

  async *run(req: EvalRequest, signal: AbortSignal): AsyncGenerator<NativeGenerationStep, Champion[], void> {
    const snapshot = await getBarsSnapshot(req.snapshotId)
    if (!snapshot) throw new Error("K 线快照不存在或已被清理，请删除任务后重新创建")
    return yield* this.runDirect(snapshot.bars, req, signal)
  }

  runDirect(bars: NativeBar[], req: EvalRequest, signal: AbortSignal): NativeRunGenerator {
    const controller = new AbortController()
    const abort = () => controller.abort()
    const owned: OwnedRun = { controller, cleanup: () => { signal.removeEventListener("abort", abort); this.#runs.delete(owned) } }
    if (signal.aborted || this.#disposed) controller.abort()
    else signal.addEventListener("abort", abort, { once: true })
    owned.generator = this.#runDirect(bars, req, owned)
    this.#runs.add(owned)
    return owned.generator
  }

  async *#runDirect(bars: NativeBar[], req: EvalRequest, owned: OwnedRun): NativeRunGenerator {
    const signal = owned.controller.signal
    let client: ConnectedClient | undefined
    let lease: NativeProcessLease | undefined
    try {
      if (signal.aborted) return []
      client = this.#options.createClient?.() ?? new NativeEngineClient({ onStage: message => this.#options.onStage?.(nativeStageLabel(message)) })
      const precision = this.#options.precision ?? "mixed"
      // An aborted caller must never kill the process another session uses.
      let endpoint: NativeEndpoint
      try {
        endpoint = this.#options.launch ? await this.#options.launch({ precision })
          : (lease = await nativeProcessQueue.acquire(precision, signal)).endpoint
      } catch (error) {
        if (signal.aborted || (error instanceof Error && error.name === "AbortError")) throw error
        throw new NativeEngineError(error instanceof Error ? error.message : String(error), "STARTUP_UNAVAILABLE")
      }
      if (signal.aborted) return []
      const hello = await client.connect(endpoint, signal)
      if (hello.precision !== precision) throw new NativeEngineError("原生引擎精度模式不匹配", "INVALID_HANDSHAKE")
      return yield* runNativeGpuSession(client, hello, bars, req, signal)
    } catch (error) {
      if (nativeProcessLost(error) || nativeUnavailable(error)) await lease?.invalidate().catch(() => undefined)
      throw error
    } finally {
      client?.close()
      lease?.release()
      owned.cleanup()
    }
  }

  async dispose(): Promise<void> {
    this.#disposed = true
    const runs = [...this.#runs]
    for (const run of runs) run.controller.abort()
    // AsyncGenerator.return queues behind an active next(), so a numerical
    // generation completes before its finally releases the resident session.
    await Promise.allSettled(runs.map(run => run.generator!.return([])))
    // A never-started generator does not enter its finally.
    for (const run of runs) run.cleanup()
  }
}
