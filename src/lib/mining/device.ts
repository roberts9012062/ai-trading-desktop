/**
 * 设备探测与降级(M4)
 *
 * GPU 只存在于客户端:服务端挖掘一律 CPU,与本文件无关。显式选 GPU 但
 * 不可用时必须把 reason 交给 UI 提示(不能静默降级——用户是冲着速度选的)。
 * probeGpu 只做可用性判定(adapter 级,不占设备);实际计算设备由
 * GpuBackend 申请并挂 device.lost 处理(掉设备 → 任务转 paused 可恢复)。
 */

import type { DeviceKind } from "./types"

export interface DeviceResolution {
  device: "cpu" | "gpu"
  degraded: boolean
  reason?: string
}

export interface GpuProbeResult {
  available: boolean
  reason?: string
  detail?: string
}

export async function probeGpu(): Promise<GpuProbeResult> {
  if (typeof navigator === "undefined" || !("gpu" in navigator) || !navigator.gpu) {
    return {
      available: false,
      reason: "当前 WebView 不支持 WebGPU，请升级 Edge WebView2 运行时",
    }
  }
  let adapter: GPUAdapter | null = null
  try {
    adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" })
  } catch (e) {
    return { available: false, reason: `WebGPU 适配器获取失败:${e instanceof Error ? e.message : String(e)}` }
  }
  if (!adapter) {
    return { available: false, reason: "未获取到 WebGPU 适配器(可能被浏览器/系统策略禁用)" }
  }
  if (adapter.limits.maxStorageBufferBindingSize < 128 * 1024 * 1024) {
    return {
      available: false,
      reason: `WebGPU 存储缓冲上限不足(${Math.round(adapter.limits.maxStorageBufferBindingSize / 1048576)}MB < 128MB)`,
    }
  }
  if (adapter.limits.maxComputeWorkgroupStorageSize < 16384) {
    return {
      available: false,
      reason: "WebGPU workgroup 共享内存不足(<16KB)",
    }
  }
  return { available: true, detail: adapter.info ? `${adapter.info.vendor || ""} ${adapter.info.architecture || ""}`.trim() : undefined }
}

export async function resolveDevice(want: DeviceKind): Promise<DeviceResolution> {
  if (want === "cpu") return { device: "cpu", degraded: false }
  const probe = await probeGpu()
  if (probe.available) return { device: "gpu", degraded: false }
  if (want === "gpu") {
    // 显式选了 GPU 但不可用:降级 CPU 并带原因(UI 必须提示)
    return { device: "cpu", degraded: true, reason: probe.reason }
  }
  // auto:静默落 CPU
  return { device: "cpu", degraded: false }
}

/** GpuBackend 用:申请计算设备并注册掉设备回调(返回 lost 的 promise 供轮询) */
export async function acquireGpuDevice(onLost: (reason: string) => void): Promise<GPUDevice> {
  const probe = await probeGpu()
  if (!probe.available) throw new Error(probe.reason ?? "WebGPU 不可用")
  const adapter = (await navigator.gpu!.requestAdapter({ powerPreference: "high-performance" }))!
  // requiredLimits 拉满 buffer 上限:requestDevice 默认只给 128MB 绑定,
  // 强 GPU(如 RTX 5060 Ti 16GB,adapter 上限 2GB)的大批粗排依赖显式请求
  const device = await adapter.requestDevice({
    requiredLimits: {
      maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
      maxBufferSize: adapter.limits.maxBufferSize,
    },
  })
  device.lost.then((info) => {
    onLost(info.message || "unknown")
  })
  return device
}
