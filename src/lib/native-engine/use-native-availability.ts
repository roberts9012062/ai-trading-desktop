import { useEffect, useState } from "react"
import { isTauri } from "@tauri-apps/api/core"
import { NativeEngineClient } from "./ipc"
import { nativeProcessQueue } from "./process-lease"
import type { NativePrecision, NativeProbeResult } from "./types"

export async function probeQueuedNative(precision: NativePrecision = "mixed", signal = new AbortController().signal): Promise<NativeProbeResult> {
  if (!isTauri()) return { available: false, reason: "原生 GPU 引擎仅在 Tauri 桌面端可用" }
  let lease: Awaited<ReturnType<typeof nativeProcessQueue.acquire>> | undefined
  const client = new NativeEngineClient()
  try {
    lease = await nativeProcessQueue.acquire(precision, signal)
    const hello = await client.connect(lease.endpoint, signal)
    return { available: true, hello, detail: `${hello.device_name} · ${hello.engine_version}` }
  } catch (error) {
    if (signal.aborted) throw error
    return { available: false, reason: error instanceof Error ? error.message : String(error) }
  } finally { client.close(); lease?.release() }
}

/** Lazy cold JIT: CPU/WebGPU users do not start a CUDA process by opening UI. */
export function useNativeAvailability(selected: boolean, precision: NativePrecision = "mixed") {
  const [result, setResult] = useState<NativeProbeResult | null>(() => isTauri() ? null : { available: false, reason: "仅 Tauri 桌面端可用" })
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (!selected || !isTauri()) return
    const controller = new AbortController()
    void probeQueuedNative(precision, controller.signal).then(setResult).catch(() => undefined)
    return () => controller.abort()
  }, [selected, precision, attempt])
  return { ...result, retry: () => setAttempt(value => value + 1) }
}
