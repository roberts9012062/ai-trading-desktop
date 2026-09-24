/**
 * Task-resident features and bounded, queued tiles. WebGPU exposes one queue,
 * not CUDA streams: independent staging buffers overlap readback with compute.
 */
import { MAX_TOKENS, TOKEN_PAD } from "./tokens"
import { EVAL_VM_WGSL } from "./wgsl/eval-vm.wgsl"

const STACK_SLOTS = 9
const DEFAULT_BATCH_BYTES = 256 * 1024 * 1024
const TILE_MAX = 16384
export const METRICS_WORKGROUP_SIZE = 64

export interface GpuEvalOptions {
  F: number
  T: number
  periods: number
  cost: number
  population?: number
  maxBatchBytes?: number
  readbackDepth?: 1 | 2
}

export interface GpuEvalSetup {
  device: GPUDevice
  tile: number
  T: number
  F: number
  periods: number
  cost: number
  bufferBytes: number
  pipelineVM: GPUComputePipeline
  pipelineMetrics: GPUComputePipeline
  bindGroup: GPUBindGroup
  paramsBuf: GPUBuffer
  tokensBuf: GPUBuffer
  metricsBuf: GPUBuffer
  staging: GPUBuffer[]
  buffers: GPUBuffer[]
  busy: boolean
}

export function planGpuTile(limits: GPUSupportedLimits, opts: GpuEvalOptions): number {
  const { F, T, population = TILE_MAX, maxBatchBytes = DEFAULT_BATCH_BYTES } = opts
  if (!Number.isSafeInteger(T) || T < 2 || !Number.isSafeInteger(F) || F < 1 || F > 64 ||
      !Number.isSafeInteger(population) || population < 1 ||
      !Number.isFinite(maxBatchBytes) || maxBatchBytes <= 0 ||
      !Number.isFinite(opts.periods) || opts.periods <= 0 || !Number.isFinite(opts.cost)) {
    throw new Error("Invalid GPU evaluation dimensions or parameters")
  }
  const cap = Math.min(limits.maxStorageBufferBindingSize, limits.maxBufferSize)
  if (F * T * 4 > cap) throw new Error("GPU feature matrix exceeds device buffer limit")
  const perCandidate = STACK_SLOTS * T * 4 + T * 4 + MAX_TOKENS * 4 + 8 + 36 * 3
  const tile = Math.floor(Math.min(
    TILE_MAX, population, limits.maxComputeWorkgroupsPerDimension,
    cap / (STACK_SLOTS * T * 4), maxBatchBytes / perCandidate,
  ))
  if (tile < 1) throw new Error("GPU buffer budget cannot fit one candidate")
  return tile
}

async function popErrors(device: GPUDevice): Promise<void> {
  const allocation = await device.popErrorScope()
  const validation = await device.popErrorScope()
  const error = allocation ?? validation
  if (error) throw new Error(`WebGPU evaluation failed: ${error.message}`)
}

export async function createGpuEval(
  device: GPUDevice,
  feat: Float32Array<ArrayBuffer>,
  ret: Float32Array<ArrayBuffer>,
  opts: GpuEvalOptions,
): Promise<GpuEvalSetup> {
  const { F, T, periods, cost } = opts
  const tile = planGpuTile(device.limits, opts)
  if (feat.length !== F * T || ret.length !== T) throw new Error("GPU input shape mismatch")
  const buffers: GPUBuffer[] = []
  let bufferBytes = 0
  device.pushErrorScope("validation")
  device.pushErrorScope("out-of-memory")
  let scopesPopped = false
  try {
    const module = device.createShaderModule({ code: EVAL_VM_WGSL })
    const info = await module.getCompilationInfo()
    const errors = info.messages.filter((m) => m.type === "error")
    if (errors.length) {
      throw new Error(`WGSL compilation failed: ${errors.map((m) => `${m.lineNum}: ${m.message}`).join("; ")}`)
    }
    const layout = device.createPipelineLayout({
      bindGroupLayouts: [device.createBindGroupLayout({
        entries: Array.from({ length: 8 }, (_, binding) => ({
          binding,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: (binding === 0 ? "uniform" : binding <= 3 ? "read-only-storage" : "storage") as GPUBufferBindingType },
        })),
      })],
    })
    const [pipelineVM, pipelineMetrics] = await Promise.all([
      device.createComputePipelineAsync({ layout, compute: { module, entryPoint: "evalVM" } }),
      device.createComputePipelineAsync({ layout, compute: { module, entryPoint: "evalMetrics" } }),
    ])
    const mkBuf = (size: number, usage: GPUBufferUsageFlags) => {
      const buffer = device.createBuffer({ size, usage })
      buffers.push(buffer)
      bufferBytes += size
      return buffer
    }
    const featBuf = mkBuf(F * T * 4, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST)
    const retBuf = mkBuf(T * 4, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST)
    device.queue.writeBuffer(featBuf, 0, feat)
    device.queue.writeBuffer(retBuf, 0, ret)
    const paramsBuf = mkBuf(32, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST)
    const tokensBuf = mkBuf(tile * MAX_TOKENS * 4, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST)
    const stkBuf = mkBuf(tile * STACK_SLOTS * T * 4, GPUBufferUsage.STORAGE)
    const factorBuf = mkBuf(tile * T * 4, GPUBufferUsage.STORAGE)
    const statsBuf = mkBuf(tile * 8, GPUBufferUsage.STORAGE)
    const metricsBuf = mkBuf(tile * 36, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC)
    const staging = Array.from({ length: opts.readbackDepth ?? 2 }, () =>
      mkBuf(tile * 36, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST))
    const bindings = [paramsBuf, featBuf, tokensBuf, retBuf, stkBuf, factorBuf, statsBuf, metricsBuf]
    const bindGroup = device.createBindGroup({
      layout: pipelineVM.getBindGroupLayout(0),
      entries: bindings.map((buffer, binding) => ({ binding, resource: { buffer } })),
    })
    scopesPopped = true
    await popErrors(device)
    return {
      device, tile, T, F, periods, cost, bufferBytes,
      pipelineVM, pipelineMetrics, bindGroup, paramsBuf, tokensBuf, metricsBuf,
      staging, buffers, busy: false,
    }
  } catch (error) {
    if (!scopesPopped) await popErrors(device).catch(() => undefined)
    for (const buffer of buffers) buffer.destroy()
    throw error
  }
}

export function disposeGpuEval(setup: GpuEvalSetup): void {
  for (const buffer of setup.buffers) buffer.destroy()
}

export async function gpuEvalBatch(setup: GpuEvalSetup, tokensList: number[][]): Promise<Float32Array> {
  const total = tokensList.length
  if (!total) return new Float32Array(0)
  if (setup.busy) throw new Error("Concurrent evaluation on the same GPU setup is not supported")
  setup.busy = true
  const out = new Float32Array(total * 9)
  const pad = new Uint32Array(Math.min(total, setup.tile) * MAX_TOKENS)
  const pending: Array<Promise<void> | undefined> = []
  let readError: unknown
  const device = setup.device
  device.pushErrorScope("validation")
  device.pushErrorScope("out-of-memory")
  try {
    for (let start = 0, batch = 0; start < total; start += setup.tile, batch++) {
      const slot = batch % setup.staging.length
      // Await only when reusing a staging slot, not after every submission.
      if (pending[slot]) await pending[slot]
      if (readError) throw readError
      const count = Math.min(setup.tile, total - start)
      pad.fill(TOKEN_PAD, 0, count * MAX_TOKENS)
      for (let i = 0; i < count; i++) {
        const tokens = tokensList[start + i]
        if (tokens.length <= MAX_TOKENS) pad.set(tokens, i * MAX_TOKENS)
      }
      device.queue.writeBuffer(setup.tokensBuf, 0, pad, 0, count * MAX_TOKENS)
      const params = new Uint32Array([setup.T, setup.F, count, MAX_TOKENS, STACK_SLOTS, 0, 0, 0])
      const floats = new Float32Array(params.buffer)
      floats[5] = setup.periods
      floats[6] = setup.cost
      device.queue.writeBuffer(setup.paramsBuf, 0, params)
      const enc = device.createCommandEncoder()
      const pass = enc.beginComputePass()
      pass.setPipeline(setup.pipelineVM)
      pass.setBindGroup(0, setup.bindGroup)
      pass.dispatchWorkgroups(count)
      pass.setPipeline(setup.pipelineMetrics)
      pass.dispatchWorkgroups(Math.ceil(count / METRICS_WORKGROUP_SIZE))
      pass.end()
      const staging = setup.staging[slot]
      const bytes = count * 36
      enc.copyBufferToBuffer(setup.metricsBuf, 0, staging, 0, bytes)
      device.queue.submit([enc.finish()])
      const offset = start * 9
      pending[slot] = staging.mapAsync(GPUMapMode.READ, 0, bytes).then(() => {
        try {
          out.set(new Float32Array(staging.getMappedRange(0, bytes)), offset)
        } finally {
          staging.unmap()
        }
      }).catch((error: unknown) => { readError ??= error })
    }
    await Promise.all(pending)
    if (readError) throw readError
    if (!out.every(Number.isFinite)) throw new Error("GPU returned non-finite metrics")
    return out
  } finally {
    await Promise.all(pending)
    try {
      await popErrors(device)
    } finally {
      setup.busy = false
    }
  }
}
