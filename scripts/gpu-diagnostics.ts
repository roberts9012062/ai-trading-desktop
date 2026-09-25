/**
 * Run from a Vite development page:
 * const d = await import("/scripts/gpu-diagnostics.ts");
 * await d.runGpuParity(); await d.runGpuStress();
 * Synthetic data only. Never writes tasks, champions or trading state.
 */
import { acquireGpuDevice } from "../src/lib/mining/device"
import { createGpuEval, disposeGpuEval, gpuEvalBatch } from "../src/lib/mining/gpu/eval-gpu"
import { Rng, gpuOpSets, randomTreeGpuSafe, treeToTokens } from "../src/lib/mining/gpu/gp"
import { nextRet } from "../src/lib/mining/gpu/eval-core"
import { ensurePyWorker } from "../src/lib/py-worker"
import { GpuBackend } from "../src/lib/mining/backends/gpu-backend"

export function makeBars(n = 420) {
  const rng = new Rng(7)
  let price = 1000
  return Array.from({ length: n }, (_, i) => {
    const open = price
    price *= 1 + Math.sqrt(-2 * Math.log(Math.max(rng.next(), 1e-12))) *
      Math.cos(2 * Math.PI * rng.next()) * 0.018 + 0.0002
    return {
      time: new Date(Date.UTC(2023, 0, 1 + i)).toISOString(),
      open, close: price, high: Math.max(open, price) * 1.001, low: Math.min(open, price) * 0.999,
      volume: Math.floor(1000 + rng.next() * 49000),
      open_interest: Math.floor(5000 + rng.next() * 85000),
    }
  })
}

function candidates(n: number, F: number, active?: number[]) {
  const rng = new Rng(99, active)
  const { opOne, opTwo } = gpuOpSets()
  return Array.from({ length: n }, () => treeToTokens(randomTreeGpuSafe(4, F, opOne, opTwo, rng)))
}

function spearman(a: number[], b: number[]) {
  const rank = (xs: number[]) => {
    const sorted = xs.map((v, i) => ({ v: Math.round(v * 1e6) / 1e6, i })).sort((x, y) => x.v - y.v)
    const out: number[] = []
    for (let i = 0; i < sorted.length;) {
      let j = i + 1
      while (j < sorted.length && sorted[j].v === sorted[i].v) j++
      for (let k = i; k < j; k++) out[sorted[k].i] = (i + j - 1) / 2
      i = j
    }
    return out
  }
  const x = rank(a), y = rank(b), m = (a.length - 1) / 2
  let xy = 0, xx = 0, yy = 0
  x.forEach((v, i) => { xy += (v - m) * (y[i] - m); xx += (v - m) ** 2; yy += (y[i] - m) ** 2 })
  return xy / Math.sqrt(xx * yy)
}

export async function runGpuParity(n = 500, cryptoProfile = false) {
  const bars = makeBars()
  const py = ensurePyWorker()
  const base = { symbol: cryptoProfile ? "BTCUSDT" : "rb8888", crypto_profile: cryptoProfile, timeframe: "1d", train_ratio: 0.7, test_recent_bars: 0, cost: 0.001 }
  const features = await py.factorRun({ ...base, mode: "mine_features" }, bars) as {
    matrix: number[][]; train_len: number; periods: number; cost: number; active_feature_ids: number[]
  }
  const F = features.matrix.length, T = features.train_len
  const tokens = candidates(n, F, cryptoProfile ? features.active_feature_ids : undefined)
  const cpu = await py.factorRun({ ...base, mode: "mine_eval_shard", candidates: tokens }, bars) as {
    evaluated: Array<{ tokens: number[]; composite: number }>
  }
  const cpuMap = new Map(cpu.evaluated.map((e) => [e.tokens.join(","), e.composite]))
  const device = await acquireGpuDevice(() => undefined)
  let setup: Awaited<ReturnType<typeof createGpuEval>> | undefined
  try {
    setup = await createGpuEval(device, new Float32Array(features.matrix.flat()),
      new Float32Array(nextRet(bars.slice(0, T).map((b) => b.close))),
      { F, T, periods: features.periods, cost: features.cost, population: n })
    const first = await gpuEvalBatch(setup, tokens)
    const repeat = await gpuEvalBatch(setup, tokens)
    const cpuScores: number[] = [], gpuScores: number[] = []
    tokens.forEach((t, i) => {
      const ref = cpuMap.get(t.join(","))
      if (ref === undefined) return
      cpuScores.push(ref)
      gpuScores.push(first[i * 9 + 8] - 0.02 * Math.max(0, t.length - 12))
    })
    const top = (xs: number[], k: number) => xs.map((v, i) => ({ v, i })).sort((a, b) => b.v - a.v).slice(0, k).map((x) => x.i)
    const gpuTop = new Set(top(gpuScores, 30))
    const correlation = spearman(cpuScores, gpuScores)
    const recall = top(cpuScores, 10).filter((i) => gpuTop.has(i)).length
    const deterministic = first.every((v, i) => v === repeat[i])
    return { candidates: n, valid: cpuScores.length, correlation, recall, deterministic,
      passed: cpuScores.length >= 300 && correlation >= 0.98 && recall >= 8 && deterministic }
  } finally {
    if (setup) disposeGpuEval(setup)
    device.destroy()
  }
}

export async function runGpuStress(opts: { T?: number; population?: number; durationMs?: number; readbackDepth?: 1 | 2 } = {}) {
  const startedAt = new Date().toISOString()
  const { T = 4096, population = 4096, durationMs = 15000, readbackDepth = 2 } = opts
  const F = 8
  const feat = Float32Array.from({ length: F * T }, (_, i) => Math.sin(i * 0.031) + Math.cos(i * 0.017))
  const ret = Float32Array.from({ length: T }, (_, i) => Math.sin(i * 0.071) * 0.01)
  const tokens = candidates(population, F)
  const device = await acquireGpuDevice(() => undefined)
  let setup: Awaited<ReturnType<typeof createGpuEval>> | undefined
  try {
    setup = await createGpuEval(device, feat, ret, { F, T, population, periods: 243, cost: 0.001, readbackDepth })
    const expected = await gpuEvalBatch(setup, tokens)
    if (!expected.some((v) => v !== 0)) throw new Error("All-zero GPU output")
    const start = performance.now()
    let rounds = 0
    do {
      const result = await gpuEvalBatch(setup, tokens)
      if (!result.every((v, i) => v === expected[i])) throw new Error("Non-deterministic GPU output")
      rounds++
    } while (performance.now() - start < durationMs)
    const elapsedMs = performance.now() - start
    return { startedAt, endedAt: new Date().toISOString(), T, population, readbackDepth, rounds, elapsedMs, evaluationsPerSecond: rounds * population * 1000 / elapsedMs,
      tile: setup.tile, bufferBytes: setup.bufferBytes, deterministic: true }
  } finally {
    if (setup) disposeGpuEval(setup)
    device.destroy()
  }
}

export async function runMiningSmoke(population = 512, generations = 3, cryptoProfile = false) {
  const backend = new GpuBackend()
  const steps = []
  const start = performance.now()
  const gen = backend.runDirect(makeBars(cryptoProfile ? 1200 : 600), {
    snapshotId: "diagnostic-only", startGeneration: 0,
    config: { symbol: cryptoProfile ? "BTCUSDT" : "rb8888", crypto_profile: cryptoProfile, selection_v2: cryptoProfile, timeframe: "1d", population, generations, max_depth: 4,
      train_ratio: 0.7, test_recent_bars: 0, walk_forward_folds: 0, top_n: 3, cost: 0.001, seed: 42 },
  }, new AbortController().signal)
  for await (const step of gen) steps.push(step)
  return { elapsedMs: performance.now() - start, steps }
}
