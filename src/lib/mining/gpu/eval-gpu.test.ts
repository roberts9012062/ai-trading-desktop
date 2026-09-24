import { afterEach, describe, expect, it, vi } from "vitest"
import { createGpuEval, disposeGpuEval, gpuEvalBatch, planGpuTile } from "./eval-gpu"

const limits = {
  maxStorageBufferBindingSize: 128 * 1024 * 1024,
  maxBufferSize: 256 * 1024 * 1024,
  maxComputeWorkgroupsPerDimension: 65535,
} as GPUSupportedLimits
const opts = { F: 2, T: 100, periods: 243, cost: 0.001, population: 3 }

function mockDevice(compilationError = false) {
  vi.stubGlobal("GPUBufferUsage", { STORAGE: 1, COPY_DST: 2, UNIFORM: 4, COPY_SRC: 8, MAP_READ: 16 })
  vi.stubGlobal("GPUShaderStage", { COMPUTE: 1 })
  vi.stubGlobal("GPUMapMode", { READ: 1 })
  const buffers: Array<ReturnType<typeof makeBuffer>> = []
  const events: string[] = []
  function makeBuffer(size: number) {
    const data = new ArrayBuffer(size)
    return {
      data,
      destroy: vi.fn(),
      unmap: vi.fn(),
      getMappedRange: (_offset: number, bytes: number) => data.slice(0, bytes),
      mapAsync: vi.fn(async () => { await Promise.resolve(); events.push("read") }),
    }
  }
  const pipeline = { getBindGroupLayout: () => ({}) }
  const dispatch = vi.fn()
  const device = {
    limits,
    pushErrorScope: vi.fn(),
    popErrorScope: vi.fn(async () => null as GPUError | null),
    createShaderModule: () => ({
      getCompilationInfo: async () => ({
        messages: compilationError ? [{ type: "error", lineNum: 9, message: "bad shader" }] : [],
      }),
    }),
    createPipelineLayout: () => ({}),
    createBindGroupLayout: () => ({}),
    createComputePipelineAsync: vi.fn(async () => pipeline),
    createBuffer: vi.fn(({ size }: { size: number }) => {
      const b = makeBuffer(size)
      buffers.push(b)
      return b
    }),
    createBindGroup: () => ({}),
    createCommandEncoder: () => {
      let copy: (() => void) | undefined
      return {
        beginComputePass: () => ({
          setPipeline: vi.fn(), setBindGroup: vi.fn(), dispatchWorkgroups: dispatch, end: vi.fn(),
        }),
        copyBufferToBuffer: (_src: unknown, _so: number, dst: ReturnType<typeof makeBuffer>, _do: number, bytes: number) => {
          // Simulate outputs using each candidate's first token.
          const input = new Uint32Array(buffers[3].data).slice()
          copy = () => {
            const output = new Float32Array(dst.data)
            for (let i = 0; i < bytes / 36; i++) output.fill(input[i * 32], i * 9, (i + 1) * 9)
          }
        },
        finish: () => copy,
      }
    },
    queue: {
      writeBuffer: vi.fn((buffer: ReturnType<typeof makeBuffer>, offset: number, data: ArrayBufferView, dataOffset = 0, size?: number) => {
        const input = new Uint8Array(data.buffer, data.byteOffset + dataOffset * 4, (size ?? data.byteLength / 4) * 4)
        new Uint8Array(buffer.data).set(input, offset)
      }),
      submit: vi.fn((commands: Array<() => void>) => {
        events.push("submit")
        commands.forEach((c) => c())
      }),
    },
  }
  return { device: device as unknown as GPUDevice, raw: device, buffers, events, dispatch }
}

afterEach(() => vi.unstubAllGlobals())

describe("GPU buffer planning and readback", () => {
  it("sizes for population and rejects impossible buffers instead of forcing four candidates", () => {
    expect(planGpuTile(limits, opts)).toBe(3)
    expect(() => planGpuTile(limits, { ...opts, T: 0 })).toThrow()
    expect(() => planGpuTile(limits, { ...opts, maxBatchBytes: 10 })).toThrow("one candidate")
    expect(() => planGpuTile(limits, { ...opts, T: 100_000_000 })).toThrow("feature matrix")
    expect(planGpuTile(limits, { ...opts, population: 100000 })).toBeLessThanOrEqual(16384)
  })

  it("fails closed on shader compilation errors", async () => {
    const { device, raw } = mockDevice(true)
    await expect(createGpuEval(device, new Float32Array(200), new Float32Array(100), opts))
      .rejects.toThrow("WGSL compilation failed")
    expect(raw.createBuffer).not.toHaveBeenCalled()
    expect(raw.popErrorScope).toHaveBeenCalledTimes(2)
  })

  it("submits two tiles before readback, preserves ordering and uploads only active tokens", async () => {
    const { device, raw, events, dispatch, buffers } = mockDevice()
    const setup = await createGpuEval(device, new Float32Array(200), new Float32Array(100), opts)
    const output = await gpuEvalBatch(setup, [[1], [2], [3], [4], [5], [6], [7]])
    expect(Array.from(output).filter((_, i) => i % 9 === 0)).toEqual([1, 2, 3, 4, 5, 6, 7])
    expect(events.slice(0, 2)).toEqual(["submit", "submit"])
    expect(dispatch.mock.calls.map(([n]) => n)).toEqual([3, 1, 3, 1, 1, 1])
    const uploads = raw.queue.writeBuffer.mock.calls.filter(([b]) => (b as unknown) === setup.tokensBuf)
    expect(uploads.map((c) => c[4])).toEqual([96, 96, 32])
    disposeGpuEval(setup)
    expect(buffers.every((b) => b.destroy.mock.calls.length === 1)).toBe(true)
    expect(setup.bufferBytes).toBe(buffers.reduce((n, b) => n + b.data.byteLength, 0))
  })

  it("surfaces validation failure instead of accepting zero-filled output", async () => {
    const { device, raw } = mockDevice()
    const setup = await createGpuEval(device, new Float32Array(200), new Float32Array(100), opts)
    raw.popErrorScope.mockResolvedValueOnce(null).mockResolvedValueOnce({ message: "invalid dispatch" })
    await expect(gpuEvalBatch(setup, [[1]])).rejects.toThrow("invalid dispatch")
    expect(setup.busy).toBe(false)
  })

  it("rejects overlapping calls and releases busy state after map failure", async () => {
    const { device, buffers } = mockDevice()
    const setup = await createGpuEval(device, new Float32Array(200), new Float32Array(100), opts)
    buffers[8].mapAsync.mockRejectedValueOnce(new Error("device lost"))
    const pending = gpuEvalBatch(setup, [[1]])
    await expect(gpuEvalBatch(setup, [[2]])).rejects.toThrow("Concurrent")
    await expect(pending).rejects.toThrow("device lost")
    expect(setup.busy).toBe(false)
  })

  it("destroys allocated buffers when setup fails validation", async () => {
    const { device, raw, buffers } = mockDevice()
    raw.popErrorScope.mockResolvedValueOnce({ message: "allocation failed" })
    await expect(createGpuEval(device, new Float32Array(200), new Float32Array(100), opts)).rejects.toThrow("allocation failed")
    expect(buffers.length).toBeGreaterThan(0)
    expect(buffers.every((b) => b.destroy.mock.calls.length === 1)).toBe(true)
  })
})
