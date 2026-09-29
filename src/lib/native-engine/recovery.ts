import type { Champion } from "@/lib/factor-lab-api"
import type { EvalRequest, GenerationStep, SerializedBest } from "@/lib/mining/backends/types"
import type { NativeBar } from "./bars"
import { NativeEngineError } from "./ipc"
import { qualifyFallback } from "./qualification"
import { LOCAL_MINING_KERNEL_VERSION } from "@/lib/mining/crypto-profile"

export type NativeActualEngine = "native-gpu" | "gpu" | "cpu"
export interface NativeRecoveryState { restarts: number; engine: NativeActualEngine; reason: string }
export class NativeRecoveryPaused extends NativeEngineError {
  constructor(message: string, readonly restarts: number) { super(message, "RECOVERY_EXHAUSTED") }
}
export interface DirectBackend {
  runDirect(bars: NativeBar[], req: EvalRequest, signal: AbortSignal): AsyncGenerator<GenerationStep, Champion[], void>
  dispose(): Promise<void>
}
export function nativeProcessLost(error: unknown): boolean {
  return error instanceof NativeEngineError && ["DISCONNECTED", "CONNECTION_ERROR", "TIMEOUT"].includes(error.code)
}
export function nativeUnavailable(error: unknown): boolean {
  return error instanceof NativeEngineError && ["STARTUP_UNAVAILABLE", "DESKTOP_REQUIRED", "SELF_CHECK_FAILED", "ENGINE_VERSION_MISMATCH", "CUDA_UNAVAILABLE", "DRIVER_UNAVAILABLE", "FP64_UNSUPPORTED"].includes(error.code)
}

/** D-1 recovery retains only completed generations; scores never cross origins. */
export async function* runNativeRecovery(
  bars: NativeBar[], req: EvalRequest, signal: AbortSignal,
  create: (engine: NativeActualEngine) => Promise<DirectBackend>,
  onRecovery?: (state: NativeRecoveryState) => void | Promise<void>,
): AsyncGenerator<GenerationStep, Champion[], void> {
  let engine: NativeActualEngine = req.actualEngine ?? "native-gpu"
  let restarts = req.nativeRestarts ?? 0, start = req.startGeneration
  let seeds: SerializedBest[] = req.seedBest ?? [], final: Champion[] = [], reason: string | undefined
  let tokens = [...new Map([...(req.config.seed_tokens ?? []), ...(req.seedBest ?? []).map(row => row.tokens)]
    .map(row => [row.join(","), row])).values()]
  if (engine !== "native-gpu") seeds = seeds.filter(row => row.metrics.kernel_version === LOCAL_MINING_KERNEL_VERSION)
  while (!signal.aborted) {
    let backend: DirectBackend | undefined, gen: ReturnType<DirectBackend["runDirect"]> | undefined
    try {
      backend = await create(engine)
      gen = backend.runDirect(bars, { ...req, startGeneration: start, seedBest: seeds, nativeRestarts: restarts,
        config: { ...req.config, seed_tokens: tokens } }, signal)
      while (true) {
        const step = await gen.next()
        if (step.done) return final
        const value = step.value
        start = value.generation
        seeds = value.bestSeen ?? value.champions.map(row => ({ tokens: row.tokens, composite: row.composite,
          metrics: row.metrics as unknown as Record<string, unknown> }))
        if (engine === "native-gpu") final = value.champions
        else {
          const partition = qualifyFallback(value.champions, req.config, bars.length, start === req.config.generations)
          final = partition.champions
          value.qualificationCounts = { research: value.champions.length, qualified: final.length,
            pending: partition.pending.length, rejected: partition.rejected.length }
          value.qualificationReasons = [...new Set([...partition.pending, ...partition.rejected].flatMap(row =>
            (row as Champion & { qualification?: { reasons: string[] } }).qualification?.reasons ?? []))]
        }
        yield { ...value, champions: final, bestSeen: seeds, actualEngine: engine,
          engineTag: engine === "native-gpu" ? value.engineTag : LOCAL_MINING_KERNEL_VERSION,
          engineVersion: engine === "native-gpu" ? value.engineVersion : LOCAL_MINING_KERNEL_VERSION,
          nativeRestarts: restarts, ...(reason ? { recoveryReason: reason } : {}) }
        if (signal.aborted) return final
      }
    } catch (error) {
      if (signal.aborted) return final
      if (engine === "native-gpu" && nativeProcessLost(error)) {
        if (restarts >= 3) throw new NativeRecoveryPaused("原生引擎自动重启预算已耗尽，已暂停，可从已完成代恢复", restarts)
        restarts++
        tokens = [...new Map([...tokens, ...seeds.map(row => row.tokens)].map(row => [row.join(","), row])).values()]
        reason = `原生进程中断，自动重启 ${restarts}/3，从第 ${start} 代按 D-1 续跑`
      } else if (engine === "native-gpu" && nativeUnavailable(error)) {
        engine = "gpu"
        reason = `原生 GPU 不可用（${error instanceof Error ? error.message : String(error)}），回退 WebGPU`
        tokens = [...new Map([...tokens, ...seeds.map(row => row.tokens)].map(row => [row.join(","), row])).values()]
        seeds = []; final = []
      } else if (engine === "gpu") {
        engine = "cpu"
        reason = `WebGPU 不可用（${error instanceof Error ? error.message : String(error)}），回退 CPU 多核`
        tokens = [...new Map([...tokens, ...seeds.map(row => row.tokens)].map(row => [row.join(","), row])).values()]
        seeds = []; final = []
      } else throw error
      await onRecovery?.({ restarts, engine, reason })
    } finally {
      await gen?.return([]).catch(() => undefined)
      await backend?.dispose().catch(() => undefined)
    }
  }
  return final
}
