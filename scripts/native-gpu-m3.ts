import { NativeGpuBackend } from "../src/lib/mining/backends/native-gpu-backend"
import type { NativeGenerationStep } from "../src/lib/mining/backends/native-gpu-core"
import { NativeEngineClient } from "../src/lib/native-engine/ipc"
import type { NativeEndpoint, NativePrecision } from "../src/lib/native-engine/types"
import type { MiningConfig } from "../src/lib/mining/types"
import type { SerializedBest } from "../src/lib/mining/backends/types"
import "./native-gpu-m3-runners"

async function verifyNativeM3(input: { endpoint: NativeEndpoint; bars: Array<{ time: string; close: number }>;
  config: MiningConfig; precision: NativePrecision }) {
  const reports = []
  for (const mode of ["complete", "pause", "dispose"] as const) {
    const controller = new AbortController(), client = new NativeEngineClient()
    let disposed = 0, connected = 0
    const dispose = client.disposeSession.bind(client), connect = client.connect.bind(client)
    client.disposeSession = async session => { await dispose(session); disposed++ }
    client.connect = async (...args) => { const hello = await connect(...args); connected++; return hello }
    const backend = new NativeGpuBackend({ precision: input.precision, createClient: () => client,
      launch: async () => input.endpoint })
    const req = { snapshotId: `m3-${mode}`, config: { ...input.config, generations: 3 }, startGeneration: 0 }
    const steps: NativeGenerationStep[] = []
    const gen = backend.runDirect(input.bars, req, controller.signal)
    let final
    try {
      while (true) {
        const row = await gen.next()
        if (row.done) { final = row.value; break }
        steps.push(row.value)
        console.log(`native-m3-stage ${mode} generation ${row.value.generation}`)
        if (mode === "pause") controller.abort()
        if (mode === "dispose") await backend.dispose()
      }
    } finally { await gen.return([]); await backend.dispose() }
    const expected = mode === "complete" ? 3 : 1
    const passed = steps.length === expected && disposed === 1 && connected === 1 &&
      steps.every(step => step.engineTag === "native-gpu-v1" && step.bestSeen.every((row: SerializedBest) =>
        row.metrics.native_eval_precision === "f64" && row.metrics.native_engine_version === step.engineVersion))
    reports.push({ mode, passed, connected, disposed, steps, final })
  }
  return { gate: "M3-core", passed: reports.every(r => r.passed), reports }
}

Object.assign(window, { verifyNativeM3 })
