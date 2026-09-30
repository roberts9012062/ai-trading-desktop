/**
 * 算子库 TS 镜像 —— 与 public/pykernel/factor_lab/ops.py 51 算子语义逐条对齐。
 *
 * 语义镜像原则：公式/窗口/头部部分窗口退化与 numpy 版一致；求和顺序尽量
 * 同构（cumsum 口径）。TS 侧是重放/流式/黄金夹具的权威实现——重放与流式
 * 共用本文件（禁止第二套）；与 Python 引擎不做逐位约束（挖掘 fitness 仍出
 * 自引擎 f64 管线），但交叉对拍测试保证数值一致（容差内）。
 */

// ── 因果 rolling 基座（窗口含当前元素，向前 w-1 个）──────────────

export type Series = Float64Array

export function tsMean(x: Series, w: number): Series {
  const n = x.length
  const out = new Float64Array(n)
  // cumsum 口径（与 numpy 版同构：c[i+1]-c[lo]）
  const c = new Float64Array(n + 1)
  for (let i = 0; i < n; i++) c[i + 1] = c[i] + x[i]
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - w + 1)
    out[i] = (c[i + 1] - c[lo]) / (i - lo + 1)
  }
  return out
}

export function tsStd(x: Series, w: number): Series {
  const n = x.length
  const m = tsMean(x, w)
  const x2 = new Float64Array(n)
  for (let i = 0; i < n; i++) x2[i] = x[i] * x[i]
  const m2 = tsMean(x2, w)
  const out = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const v = m2[i]! - m[i]! * m[i]!
    out[i] = Math.sqrt(Math.max(v, 0))
  }
  return out
}

export function tsMax(x: Series, w: number): Series {
  const out = new Float64Array(x.length)
  for (let i = 0; i < x.length; i++) {
    const lo = Math.max(0, i - w + 1)
    let m = -Infinity
    for (let j = lo; j <= i; j++) if (x[j]! > m) m = x[j]!
    out[i] = m
  }
  return out
}

export function tsMin(x: Series, w: number): Series {
  const out = new Float64Array(x.length)
  for (let i = 0; i < x.length; i++) {
    const lo = Math.max(0, i - w + 1)
    let m = Infinity
    for (let j = lo; j <= i; j++) if (x[j]! < m) m = x[j]!
    out[i] = m
  }
  return out
}

export function tsRank(x: Series, w: number): Series {
  const out = new Float64Array(x.length)
  for (let i = 0; i < x.length; i++) {
    const lo = Math.max(0, i - w + 1)
    const len = i - lo + 1
    let c = 0
    for (let j = lo; j <= i; j++) if (x[j]! <= x[i]!) c++
    out[i] = c / len
  }
  return out
}

export function tsZscore(x: Series, w: number): Series {
  const n = x.length
  const m = tsMean(x, w)
  const s = tsStd(x, w)
  const out = new Float64Array(n)
  for (let i = 0; i < n; i++) out[i] = (x[i]! - m[i]!) / Math.max(s[i]!, 1e-8)
  return out
}

export function delta(x: Series, n: number): Series {
  const out = new Float64Array(x.length)
  for (let i = n; i < x.length; i++) out[i] = x[i]! - x[i - n]!
  return out
}

export function lag(x: Series, n: number): Series {
  const out = new Float64Array(x.length)
  for (let i = n; i < x.length; i++) out[i] = x[i - n]!
  return out
}

/** 因果滚动相关；窗口不足 2 或零方差 → 0（两趟 mean/std 与 numpy 同构） */
export function tsCorr(x: Series, y: Series, w: number): Series {
  const n = x.length
  const out = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - w + 1)
    const len = i - lo + 1
    if (len < 2) continue
    let mx = 0, my = 0
    for (let j = lo; j <= i; j++) { mx += x[j]!; my += y[j]! }
    mx /= len; my /= len
    let cxy = 0, sxx = 0, syy = 0
    for (let j = lo; j <= i; j++) {
      const a = x[j]! - mx, b = y[j]! - my
      cxy += a * b; sxx += a * a; syy += b * b
    }
    const sa = Math.sqrt(sxx / len), sb = Math.sqrt(syy / len)
    if (sa < 1e-9 || sb < 1e-9) continue
    out[i] = (cxy / len) / (sa * sb)
  }
  return out
}

export function tsBeta(x: Series, y: Series, w: number): Series {
  const n = x.length
  const out = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - w + 1)
    const len = i - lo + 1
    let mx = 0, my = 0
    for (let j = lo; j <= i; j++) { mx += x[j]!; my += y[j]! }
    mx /= len; my /= len
    let cxy = 0, syy = 0
    for (let j = lo; j <= i; j++) {
      const a = x[j]! - mx, b = y[j]! - my
      cxy += a * b; syy += b * b
    }
    const v = syy / len
    out[i] = v > 1e-12 ? (cxy / len) / v : 0
  }
  return out
}

export function tsResid(x: Series, y: Series, w: number): Series {
  const beta = tsBeta(x, y, w)
  const mx = tsMean(x, w)
  const my = tsMean(y, w)
  const out = new Float64Array(x.length)
  for (let i = 0; i < x.length; i++) out[i] = (x[i]! - mx[i]!) - beta[i]! * (y[i]! - my[i]!)
  return out
}

export function tsDemean(x: Series, w: number): Series {
  const m = tsMean(x, w)
  const out = new Float64Array(x.length)
  for (let i = 0; i < x.length; i++) out[i] = x[i]! - m[i]!
  return out
}

export function ema(x: Series, w: number): Series {
  const alpha = 2 / (w + 1)
  const out = new Float64Array(x.length)
  let prev = 0
  for (let i = 0; i < x.length; i++) {
    prev = alpha * x[i]! + (1 - alpha) * prev
    out[i] = prev
  }
  return out
}

export function tsCenteredRank(x: Series, w: number): Series {
  const out = new Float64Array(x.length)
  for (let i = 0; i < x.length; i++) {
    const lo = Math.max(0, i - w + 1)
    const len = i - lo + 1
    const last = x[i]!
    const eps = 1e-6 * Math.max(1, Math.abs(last))
    let less = 0, tie = 0
    for (let j = lo; j <= i; j++) {
      const v = x[j]!
      if (v < last - eps) less++
      else if (Math.abs(v - last) <= eps) tie++
    }
    out[i] = (less + 0.5 * tie) * 2 / len - 1
  }
  return out
}

export function decayLinear(x: Series, w: number): Series {
  const out = new Float64Array(x.length)
  for (let i = 0; i < x.length; i++) {
    const lo = Math.max(0, i - w + 1)
    const len = i - lo + 1
    let num = 0, den = 0
    for (let k = 0; k < len; k++) {
      const weight = k + 1 // 最新观测权重最高
      num += x[lo + k]! * weight
      den += weight
    }
    out[i] = num / den
  }
  return out
}

export function median(values: readonly number[]): number {
  const s = [...values].sort((a, b) => a - b)
  const n = s.length
  if (n % 2 === 1) return s[(n - 1) / 2]!
  return (s[n / 2 - 1]! + s[n / 2]!) / 2
}

export function tsMedian(x: Series, w: number): Series {
  const out = new Float64Array(x.length)
  for (let i = 0; i < x.length; i++) {
    const lo = Math.max(0, i - w + 1)
    out[i] = median(Array.from(x.subarray(lo, i + 1)))
  }
  return out
}

export function tsMad(x: Series, w: number): Series {
  const out = new Float64Array(x.length)
  for (let i = 0; i < x.length; i++) {
    const lo = Math.max(0, i - w + 1)
    const win = Array.from(x.subarray(lo, i + 1))
    const med = median(win)
    out[i] = median(win.map((v) => Math.abs(v - med)))
  }
  return out
}

export function robustZscore(x: Series, w: number): Series {
  const n = x.length
  const med = tsMedian(x, w)
  const mad = tsMad(x, w)
  const out = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const scale = 1.4826 * mad[i]!
    const d = x[i]! - med[i]!
    let z: number
    if (scale > 1e-9) z = d / Math.max(scale, 1e-9)
    else z = Math.abs(d) < 1e-9 ? 0 : Math.sign(d) * 3
    out[i] = Math.min(Math.max(z, -3), 3)
  }
  return out
}

/** 线性插值分位数（numpy quantile 默认口径） */
export function quantile(sorted: readonly number[], q: number): number {
  const n = sorted.length
  if (n === 0) return NaN
  if (n === 1) return sorted[0]!
  const h = (n - 1) * q
  const lo = Math.floor(h)
  const hi = Math.min(lo + 1, n - 1)
  return sorted[lo]! + (h - lo) * (sorted[hi]! - sorted[lo]!)
}

export function rollingWinsor(x: Series, w: number): Series {
  const n = x.length
  const out = Float64Array.from(x)
  for (let i = 1; i < n; i++) {
    const lo = Math.max(0, i - w + 1)
    const len = i - lo
    if (len < 2) continue
    const hist = Array.from(x.subarray(lo, i)).sort((a, b) => a - b)
    const qLo = quantile(hist, 0.05)
    const qHi = quantile(hist, 0.95)
    out[i] = Math.min(Math.max(x[i]!, qLo), qHi)
  }
  return out
}

export function volScale(x: Series, w: number): Series {
  const s = tsStd(x, w)
  const out = new Float64Array(x.length)
  for (let i = 0; i < x.length; i++) out[i] = x[i]! / Math.max(s[i]!, 1e-8)
  return out
}

export function snr(x: Series, w: number): Series {
  const m = tsMean(x, w)
  const s = tsStd(x, w)
  const out = new Float64Array(x.length)
  for (let i = 0; i < x.length; i++) out[i] = m[i]! / Math.max(s[i]!, 1e-8)
  return out
}

// ── 一元/二元逐元素 ─────────────────────────────────────────────

export function unaryMap(x: Series, f: (v: number) => number): Series {
  const out = new Float64Array(x.length)
  for (let i = 0; i < x.length; i++) out[i] = f(x[i]!)
  return out
}

export function binaryMap(a: Series, b: Series, f: (x: number, y: number) => number): Series {
  const n = Math.min(a.length, b.length)
  const out = new Float64Array(n)
  for (let i = 0; i < n; i++) out[i] = f(a[i]!, b[i]!)
  return out
}

export const sign = (v: number) => Math.sign(v)
export const signedSqrt = (v: number) => Math.sign(v) * Math.sqrt(Math.abs(v))
export const signedLog = (v: number) => Math.sign(v) * Math.log1p(Math.abs(v))
export const sigmoid = (v: number) => {
  const c = Math.min(Math.max(v, -30), 30)
  return 2 / (1 + Math.exp(-c)) - 1
}
export const tanhClip = (v: number) => Math.tanh(Math.min(Math.max(v, -30), 30))
/** 保号除法（与 _div 同式：|b| 下限 1e-8，b+1e-12 的符号） */
export const divKeepSign = (a: number, b: number) =>
  a / Math.max(Math.abs(b), 1e-8) * Math.sign(b + 1e-12)

// ── 算子注册表（顺序即 token id 64+，冻结与 OPS_CONFIG 对齐）─────

export interface OpDef {
  name: string
  arity: 1 | 2
  apply: (args: Series[]) => Series
}

function roll(fn: (x: Series, w: number) => Series, w: number) {
  return (args: Series[]) => fn(args[0]!, w)
}

export const OPS: readonly OpDef[] = [
  { name: "ADD", arity: 2, apply: ([a, b]) => binaryMap(a!, b!, (x, y) => x + y) },
  { name: "SUB", arity: 2, apply: ([a, b]) => binaryMap(a!, b!, (x, y) => x - y) },
  { name: "MUL", arity: 2, apply: ([a, b]) => binaryMap(a!, b!, (x, y) => x * y) },
  { name: "DIV", arity: 2, apply: ([a, b]) => binaryMap(a!, b!, divKeepSign) },
  { name: "MIN", arity: 2, apply: ([a, b]) => binaryMap(a!, b!, Math.min) },
  { name: "MAX", arity: 2, apply: ([a, b]) => binaryMap(a!, b!, Math.max) },
  { name: "ABS", arity: 1, apply: ([a]) => unaryMap(a!, Math.abs) },
  { name: "NEG", arity: 1, apply: ([a]) => unaryMap(a!, (v) => -v) },
  { name: "SIGN", arity: 1, apply: ([a]) => unaryMap(a!, sign) },
  { name: "SQRT", arity: 1, apply: ([a]) => unaryMap(a!, signedSqrt) },
  { name: "SIGNED_LOG", arity: 1, apply: ([a]) => unaryMap(a!, signedLog) },
  { name: "SIGMOID", arity: 1, apply: ([a]) => unaryMap(a!, sigmoid) },
  { name: "TANH", arity: 1, apply: ([a]) => unaryMap(a!, tanhClip) },
  { name: "TS_MA_5", arity: 1, apply: roll(tsMean, 5) },
  { name: "TS_MA_10", arity: 1, apply: roll(tsMean, 10) },
  { name: "TS_MA_20", arity: 1, apply: roll(tsMean, 20) },
  { name: "TS_STD_10", arity: 1, apply: roll(tsStd, 10) },
  { name: "TS_STD_20", arity: 1, apply: roll(tsStd, 20) },
  { name: "TS_MAX_10", arity: 1, apply: roll(tsMax, 10) },
  { name: "TS_MAX_20", arity: 1, apply: roll(tsMax, 20) },
  { name: "TS_MIN_10", arity: 1, apply: roll(tsMin, 10) },
  { name: "TS_RANK_10", arity: 1, apply: roll(tsRank, 10) },
  { name: "TS_RANK_20", arity: 1, apply: roll(tsRank, 20) },
  { name: "TS_ZSCORE_20", arity: 1, apply: roll(tsZscore, 20) },
  { name: "DELTA_1", arity: 1, apply: ([a]) => delta(a!, 1) },
  { name: "DELTA_5", arity: 1, apply: ([a]) => delta(a!, 5) },
  { name: "TS_ATR_NORM", arity: 1, apply: ([a]) => unaryMap(a!, (v) => signedLog(Math.max(Math.abs(v), 1e-9))) },
  { name: "LAG_1", arity: 1, apply: ([a]) => lag(a!, 1) },
  { name: "LAG_5", arity: 1, apply: ([a]) => lag(a!, 5) },
  { name: "CORR_20", arity: 2, apply: ([a, b]) => tsCorr(a!, b!, 20) },
  { name: "TS_MA_60", arity: 1, apply: roll(tsMean, 60) },
  { name: "TS_STD_60", arity: 1, apply: roll(tsStd, 60) },
  { name: "TS_ZSCORE_60", arity: 1, apply: roll(tsZscore, 60) },
  { name: "TS_RANK_60", arity: 1, apply: roll(tsRank, 60) },
  { name: "TS_DEMEAN_20", arity: 1, apply: roll(tsDemean, 20) },
  { name: "BETA_20", arity: 2, apply: ([a, b]) => tsBeta(a!, b!, 20) },
  { name: "RESID_20", arity: 2, apply: ([a, b]) => tsResid(a!, b!, 20) },
  { name: "STEP", arity: 1, apply: ([a]) => unaryMap(a!, (v) => (v > 0 ? 1 : 0)) },
  { name: "EMA_5", arity: 1, apply: roll(ema, 5) },
  { name: "EMA_20", arity: 1, apply: roll(ema, 20) },
  { name: "TS_CRANK_20", arity: 1, apply: roll(tsCenteredRank, 20) },
  { name: "TS_CRANK_60", arity: 1, apply: roll(tsCenteredRank, 60) },
  { name: "DECAY_LINEAR_10", arity: 1, apply: roll(decayLinear, 10) },
  { name: "DECAY_LINEAR_20", arity: 1, apply: roll(decayLinear, 20) },
  { name: "ROBUST_ZSCORE_20", arity: 1, apply: roll(robustZscore, 20) },
  { name: "WINSOR_20", arity: 1, apply: roll(rollingWinsor, 20) },
  { name: "VOL_SCALE_20", arity: 1, apply: roll(volScale, 20) },
  { name: "SNR_20", arity: 1, apply: roll(snr, 20) },
  { name: "SNR_60", arity: 1, apply: roll(snr, 60) },
  { name: "TS_ZSCORE_120", arity: 1, apply: roll(tsZscore, 120) },
  { name: "DELTA_24", arity: 1, apply: ([a]) => delta(a!, 24) },
]

export const FEAT_OFFSET = 64
export const OPS_COUNT = OPS.length

/** pykernel vm.execute 的每算子后清理：NaN→0、±Inf→±1 */
export function nanToNum(x: Series): Series {
  const out = new Float64Array(x.length)
  for (let i = 0; i < x.length; i++) {
    const v = x[i]!
    if (Number.isNaN(v)) out[i] = 0
    else if (v === Infinity) out[i] = 1
    else if (v === -Infinity) out[i] = -1
    else out[i] = v
  }
  return out
}
