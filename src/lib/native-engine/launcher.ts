import { invoke, isTauri } from "@tauri-apps/api/core"
import { NativeEngineClient, NativeEngineError } from "./ipc"
import type { NativeEndpoint, NativeLaunchOptions, NativeProbeResult } from "./types"

export async function launchNativeEngine(options: NativeLaunchOptions = {}, signal?: AbortSignal): Promise<NativeEndpoint> {
  if (!isTauri()) throw new NativeEngineError("原生 GPU 引擎仅在 Tauri 桌面端可用", "DESKTOP_REQUIRED")
  if (signal?.aborted) throw new DOMException("已取消", "AbortError")
  const endpoint = await invoke<NativeEndpoint>("native_engine_spawn", { precision: options.precision ?? "mixed" })
  if (!Number.isInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65535 || typeof endpoint.token !== "string" || endpoint.token.length < 16) {
    throw new NativeEngineError("原生引擎启动握手无效", "INVALID_HANDSHAKE")
  }
  if (signal?.aborted) { await stopNativeEngine(); throw new DOMException("已取消", "AbortError") }
  return endpoint
}

export async function stopNativeEngine(): Promise<void> { await invoke("native_engine_kill") }

export async function probeNativeEngine(): Promise<NativeProbeResult> {
  if (!isTauri()) return { available: false, reason: "原生 GPU 引擎仅在 Tauri 桌面端可用" }
  const client = new NativeEngineClient()
  try {
    const endpoint = await launchNativeEngine()
    const hello = await client.connect(endpoint)
    return { available: true, hello, detail: `${hello.device_name} · ${hello.engine_version}` }
  } catch (error) {
    return { available: false, reason: error instanceof Error ? error.message : String(error) }
  } finally { client.close() }
}
