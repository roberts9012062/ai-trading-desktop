import { NativeGpuBackend } from "../src/lib/mining/backends/native-gpu-backend"
import type { NativeGenerationStep } from "../src/lib/mining/backends/native-gpu-core"
import type { Champion } from "../src/lib/factor-lab-api"
import { isCurrentNativeMetrics, NATIVE_ENGINE_VERSION } from "../src/lib/native-engine/version"
import type { NativePrecision } from "../src/lib/native-engine/types"
import type { MiningConfig } from "../src/lib/mining/types"
import type { KlineBar } from "../src/types"

/**
 * M3-E positive portfolio IPC check: feed the frozen G2 qualified champions
 * (ADAUSDT-30m f64, exactly 2) as the whole population of a one-generation
 * native session; the final precise must return a non-null GPU portfolio.
 */
async function nativePortfolioPositive(input: { bars: KlineBar[]; config: MiningConfig; precision: NativePrecision; seedTokens: number[][] }) {
  const config = { ...input.config, population: input.seedTokens.length, generations: 1,
    seed_tokens: input.seedTokens, seed: 42 }
  const backend = new NativeGpuBackend({ precision: input.precision })
  const controller = new AbortController()
  let finalStep: NativeGenerationStep | undefined
  let finalChampions: Champion[] | undefined
  try {
    const gen = backend.runDirect(input.bars, { snapshotId: "portfolio-positive", config, startGeneration: 0 }, controller.signal)
    while (true) {
      const row = await gen.next()
      if (row.done) { finalChampions = row.value; break }
      finalStep = row.value
    }
  } finally { await backend.dispose() }
  const portfolio = finalStep?.nativePortfolio ?? null
  const champions = finalChampions ?? []
  const origins = champions.map(row => isCurrentNativeMetrics(row.metrics as unknown as Record<string, unknown>))
  return { gate: "M3-portfolio-ipc", passed: finalStep?.generation === 1 && champions.length >= 2 &&
      portfolio !== null && origins.every(Boolean),
    generation: finalStep?.generation ?? 0, champions: champions.length, portfolio,
    championOriginsCurrent: origins, engineVersion: NATIVE_ENGINE_VERSION,
    championComposites: champions.map(row => row.composite) }
}

Object.assign(window, { nativePortfolioPositive })
