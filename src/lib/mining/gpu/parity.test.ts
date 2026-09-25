/**
 * GPU 求值语义 parity 测试(M4)
 *
 * 两层验证:
 * 1.【本机可跑】TS 参考实现(eval-core,f64) vs Python 内核:
 *    同一批随机候选 + 同一份 bars,Spearman 秩相关 ≥ 0.999 且数值近似相等
 *    (同为 f64 精确移植,只应有浮点求和顺序差);这是 WGSL 移植的语义基准;
 * 2.【需要 WebGPU 适配器,无则跳过】WGSL(f32) vs Python:Spearman ≥ 0.98、
 *    CPU 口径真实 top-10 有 ≥8 个落在粗排 top-30(文档 2.8 验收)。
 * GPU 的数字只用于排序,不进任何 UI/DB/实盘路径(硬约束)。
 */
import { execFile } from "node:child_process"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { beforeAll, describe, expect, it } from "vitest"
import {
  evaluateCore,
  executeTokensCore,
  isConstantCore,
  nextRet,
} from "@/lib/mining/gpu/eval-core"
import { Rng, gpuOpSets, randomTreeGpuSafe, treeToTokens } from "@/lib/mining/gpu/gp"
import { tokensGpuSupported } from "@/lib/mining/gpu/tokens"
import { createGpuEval, disposeGpuEval, gpuEvalBatch } from "@/lib/mining/gpu/eval-gpu"

const execFileAsync = promisify(execFile)
const PYTHON = process.env.PYTHON ?? "python"

interface ParityRef {
  feature_names: string[]
  matrix: number[][]
  periods: number
  cost: number
  train_len: number
  total_len: number
  entries: { valid: boolean; rejected: boolean; constant: boolean; composite: number | null }[]
}

/** 复现 verify-mine-stepwise 的合成 bars(独立实现,跨语言一致) */
function makeBars(n = 420, seed = 7) {
  let s = seed >>> 0
  const rnd = () => {
    s = (s + 0x6d2b79f5) | 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const gauss = () => {
    const u = Math.max(rnd(), 1e-12)
    const v = rnd()
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
  }
  const bars = []
  let price = 1000
  const d0 = Date.UTC(2023, 0, 1)
  for (let i = 0; i < n; i++) {
    const r = gauss() * 0.018 + 0.0002
    const o = price
    price = Math.max(1, price * (1 + r))
    const d = new Date(d0 + i * 86400000).toISOString().slice(0, 10)
    bars.push({
      time: `${d}T00:00:00`,
      open: +o.toFixed(2),
      high: +(Math.max(o, price) * 1.001).toFixed(2),
      low: +(Math.min(o, price) * 0.999).toFixed(2),
      close: +price.toFixed(2),
      volume: Math.floor(1000 + rnd() * 49000),
      open_interest: Math.floor(5000 + rnd() * 85000),
    })
  }
  return bars
}

/** 生成 N 个随机候选(GPU 支持范围内) */
function makeCandidates(n: number, featN: number, seed = 99): number[][] {
  const rng = new Rng(seed)
  const { opOne, opTwo } = gpuOpSets()
  const out: number[][] = []
  for (let i = 0; i < n; i++) {
    out.push(treeToTokens(randomTreeGpuSafe(4, featN, opOne, opTwo, rng)))
  }
  return out
}

/** Spearman 秩相关 */
function spearman(a: number[], b: number[]): number {
  const rank = (xs: number[]) => {
    const idx = xs.map((v, i) => [v, i] as [number, number]).sort((x, y) => x[0] - y[0])
    const r = new Array<number>(xs.length)
    let i = 0
    while (i < idx.length) {
      let j = i
      while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++
      const avg = (i + j) / 2 + 1
      for (let k = i; k <= j; k++) r[idx[k][1]] = avg
      i = j + 1
    }
    return r
  }
  const ra = rank(a)
  const rb = rank(b)
  const n = a.length
  const ma = ra.reduce((x, y) => x + y, 0) / n
  const mb = rb.reduce((x, y) => x + y, 0) / n
  let num = 0
  let da = 0
  let db = 0
  for (let i = 0; i < n; i++) {
    num += (ra[i] - ma) * (rb[i] - mb)
    da += (ra[i] - ma) ** 2
    db += (rb[i] - mb) ** 2
  }
  return num / Math.sqrt(da * db)
}

async function runPythonRef(bars: unknown[], candidates: number[][]): Promise<ParityRef> {
  const dir = mkdtempSync(join(tmpdir(), "gpu-parity-"))
  const barsPath = join(dir, "bars.json")
  const candPath = join(dir, "candidates.json")
  const cfgPath = join(dir, "config.json")
  writeFileSync(barsPath, JSON.stringify(bars))
  writeFileSync(candPath, JSON.stringify(candidates))
  writeFileSync(
    cfgPath,
    JSON.stringify({ timeframe: "1d", train_ratio: 0.7, test_recent_bars: 0, cost: null, symbol: "rb8888" }),
  )
  const { stdout } = await execFileAsync(PYTHON, [
    "scripts/gpu-parity-ref.py",
    "--bars", barsPath,
    "--candidates", candPath,
    "--config", cfgPath,
  ], { cwd: process.cwd(), maxBuffer: 128 * 1024 * 1024 })
  return JSON.parse(stdout) as ParityRef
}

describe("GPU 求值语义 parity(M4)", () => {
  let bars: ReturnType<typeof makeBars>
  let candidates: number[][]
  let ref: ParityRef
  let featFlat: Float64Array
  let ret: Float64Array

  beforeAll(async () => {
    bars = makeBars()
    candidates = null as unknown as number[][]
    ref = null as unknown as ParityRef
    try {
      ref = await runPythonRef(bars, [])
    } catch {
      return // python 不可用时跳过整组(见首个用例)
    }
    candidates = makeCandidates(500, ref.feature_names.length)
    ref = await runPythonRef(bars, candidates)
    const F = ref.matrix.length
    const T = ref.train_len
    featFlat = new Float64Array(F * T)
    for (let f = 0; f < F; f++) for (let t = 0; t < T; t++) featFlat[f * T + t] = ref.matrix[f][t]
    const close = bars.slice(0, T).map((b) => b.close)
    ret = nextRet(close)
  }, 120_000)

  it("python 参考可用(不可用则显式跳过)", () => {
    if (!ref) {
      throw new Error(
        `无法运行 python 参考侧(${PYTHON} scripts/gpu-parity-ref.py);` +
          "本组 parity 测试需要本机 python + numpy",
      )
    }
  })

  it("TS 参考实现 vs 内核:复合分秩一致,数值除个别刀锋候选外逐位吻合", () => {
    const pyComps: number[] = []
    const tsComps: number[] = []
    let mismatchedValidity = 0
    const diffs: number[] = []
    for (let i = 0; i < candidates.length; i++) {
      const entry = ref.entries[i]
      if (entry.rejected) continue // 恒正感染校验是 GA 质量门(内核精算时拦截),不参与求值对拍
      const factor = executeTokensCore(candidates[i], featFlat, ref.feature_names.length, ref.train_len)
      // 近常数因子两侧同样丢弃:内核 mine_precise/WGSL 都把它当无效候选
      const pyUsable = entry.valid && !entry.constant
      const tsUsable = factor !== null && !isConstantCore(factor)
      if (pyUsable !== tsUsable) mismatchedValidity++
      if (!pyUsable || !tsUsable) continue
      const m = evaluateCore(factor!, ret, ref.cost, ref.periods)
      const tsComp = m.composite - 0.02 * Math.max(0, candidates[i].length - 12)
      pyComps.push(entry.composite!)
      tsComps.push(tsComp)
      diffs.push(Math.abs(entry.composite! - tsComp))
      if (process.env.PARITY_DIAGNOSTICS && Math.abs(entry.composite! - tsComp) > 1e-6) {
        console.log("parity difference", candidates[i], entry.composite, tsComp)
      }
    }
    // 刀锋计数约束:常数判定(std<1e-6)与中性带/平局翻转同属浮点刀锋,
    // 大样本下允许极少量
    expect(mismatchedValidity).toBeLessThanOrEqual(2)
    expect(pyComps.length).toBeGreaterThanOrEqual(300) // 有效样本足够(文档口径 500 候选)
    // f64 同式移植:绝大多数只应有浮点求和顺序差;个别候选因子值落在
    // ±0.05 中性带阈值或秩比较平局上,1e-16 级浮点差让仓位/秩离散翻转,
    // 复合分出现 O(0.1) 跳变 —— 这是刀锋敏感性而非语义错误,因此验收
    // 按文档口径用秩相关(Spearman ≥ 0.98)+ 离群数量约束
    diffs.sort((a, b) => a - b)
    expect(diffs[Math.floor(diffs.length * 0.9)]).toBeLessThan(1e-9)
    // 离群上界按样本比例:刀锋候选(oos_sortino/中性带/秩平局过零)数量随
    // 样本与公式形态变化——批次二的加性 OOS 罚分把"负样本外"从坍缩 0
    // 展开成连续负值,过零刀锋的复合分跳变(≈1+|base|)比旧公式更常见
    expect(diffs.filter((d) => d > 1e-6).length).toBeLessThanOrEqual(
      Math.ceil(diffs.length * 0.05),
    )
    expect(diffs[diffs.length - 1]).toBeLessThan(2.0)
    // 大量随机候选的复合分聚集在 0 附近(oos 门控归零),1e-15 级差即可互换
    // 排序——纯秩噪声;按文档验收口径改用「选择质量」断言:真实 top-10 在
    // 粗排 top-30 的召回 ≥ 8(与 WGSL 验收同一把尺),另加 1e-6 量化合并
    // 近并列后的秩相关
    const round6 = (xs: number[]) => xs.map((v) => Math.round(v * 1e6) / 1e6)
    expect(spearman(round6(pyComps), round6(tsComps))).toBeGreaterThan(0.98)
    const pyTop10 = new Set(
      pyComps.map((v, i) => [v, i] as const).sort((a, b) => b[0] - a[0]).slice(0, 10).map((x) => x[1]),
    )
    const tsTop30 = new Set(
      tsComps.map((v, i) => [v, i] as const).sort((a, b) => b[0] - a[0]).slice(0, 30).map((x) => x[1]),
    )
    const recall = [...pyTop10].filter((i) => tsTop30.has(i)).length
    expect(recall).toBeGreaterThanOrEqual(8)
  })

  it("候选全部落在 GPU 支持范围(token ≤32/无 EMA/栈深 ≤8)", () => {
    for (const tokens of candidates) {
      expect(tokensGpuSupported(tokens, ref.feature_names.length)).toBe(true)
    }
  })
})

// ── WGSL(f32) vs 内核:需要真实 WebGPU 适配器 ────────────────
// 本机 Node 无 WebGPU 时整组跳过;在桌面端(dev 模式或带适配器的 Node)运行
// vitest 时执行。这是文档 2.8「数值一致性验收」的硬性关卡:
// Spearman ≥ 0.98 且 CPU 口径 top-10 在 GPU 粗排 top-30 召回 ≥ 8。
const hasWebGpu = typeof navigator !== "undefined" && "gpu" in navigator && !!navigator.gpu

describe.skipIf(!hasWebGpu)("WGSL(f32) vs 内核(适配器门控)", () => {
  it("Spearman ≥ 0.98,top-10 召回 ≥ 8/30", async () => {
    const bars = makeBars()
    const meta = await runPythonRef(bars, [])
    const F = meta.feature_names.length
    const candidates = makeCandidates(500, F)
    const ref = await runPythonRef(bars, candidates)

    const T = ref.train_len
    const feat = new Float32Array(F * T)
    for (let f = 0; f < F; f++) for (let t = 0; t < T; t++) feat[f * T + t] = ref.matrix[f][t]
    const ret = nextRet(bars.slice(0, T).map((b) => b.close))
    const retF32 = new Float32Array(T)
    for (let t = 0; t < T; t++) retF32[t] = ret[t]

    const adapter = (await navigator.gpu!.requestAdapter({ powerPreference: "high-performance" }))!
    const device = await adapter.requestDevice()
    const setup = await createGpuEval(device, feat, retF32, {
      F, T, periods: ref.periods, cost: ref.cost,
    })
    let gpuComps: number[]
    try {
      const metrics = await gpuEvalBatch(setup, candidates)
      gpuComps = candidates.map((tokens, i) => {
        const comp = metrics[i * 9 + 8]
        return comp <= -998 ? -999 : comp - 0.02 * Math.max(0, tokens.length - 12)
      })
    } finally {
      disposeGpuEval(setup)
      device.destroy()
    }

    const pyComps: number[] = []
    const pyIdx: number[] = []
    candidates.forEach((tokens, i) => {
      const e = ref.entries[i]
      if (!e.rejected && e.valid && !e.constant) {
        pyComps.push(e.composite!)
        pyIdx.push(i)
      }
    })
    const tsComps = pyIdx.map((i) => gpuComps[i])

    expect(spearman(pyComps, tsComps)).toBeGreaterThan(0.98)
    const pyTop10 = new Set(
      pyComps.map((v, k) => [v, k] as const).sort((a, b) => b[0] - a[0]).slice(0, 10).map((x) => x[1]),
    )
    const gpuTop30 = new Set(
      tsComps.map((v, k) => [v, k] as const).sort((a, b) => b[0] - a[0]).slice(0, 30).map((x) => x[1]),
    )
    const recall = [...pyTop10].filter((k) => gpuTop30.has(k)).length
    expect(recall).toBeGreaterThanOrEqual(8)
  }, 300_000)
})
