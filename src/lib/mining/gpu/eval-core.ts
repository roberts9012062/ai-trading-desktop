/**
 * 因子求值与指标 —— public/pykernel/factor_lab 的 TS 参考实现(f64)
 *
 * 职责定位(重要):
 * - 运行时绝不使用本文件:GPU 粗排走 WGSL(见 wgsl/eval-vm.wgsl.ts),
 *   精算与一切对外数字走 Pyodide 内核。本文件是「可执行的移植规格」,
 *   供 parity 测试与 WGSL 逐条对照,保证三处(内核/WGSL/本文档)语义一致。
 * - nextRet 是唯一被运行时复用的纯函数(GPU 后端构造收益列)。
 *
 * 逐条移植自 ops.py / vm.py / evaluate.py,含当前已知口径(如 _ts_ic 的
 * 错位、_calmar 无零基线)——parity 的对象是现状内核,口径修复属第二、三批。
 */

import { FEAT_OFFSET, OPS } from "./tokens"

// ── 供运行时复用 ────────────────────────────────────────────

/** next_ret:对齐到 t 的下一根收益率(最后一根为 0) */
export function nextRet(close: ArrayLike<number>): Float64Array {
  const n = close.length
  const ret = new Float64Array(n)
  for (let t = 0; t + 1 < n; t++) {
    ret[t] = (close[t + 1] - close[t]) / Math.max(Math.abs(close[t]), 1e-9)
  }
  return ret
}

// ── 算子(ops.py 同义移植)────────────────────────────────────

type Vec = Float64Array

function tsMean(x: Vec, w: number): Vec {
  const n = x.length
  const out = new Float64Array(n)
  const cumulative = new Float64Array(n + 1)
  for (let i = 0; i < n; i++) cumulative[i + 1] = cumulative[i] + x[i]
  for (let t = 0; t < n; t++) {
    const lo = Math.max(0, t - w + 1)
    out[t] = (cumulative[t + 1] - cumulative[lo]) / (t - lo + 1)
  }
  return out
}

function tsStd(x: Vec, w: number): Vec {
  const m = tsMean(x, w)
  const xsq = new Float64Array(x.length)
  for (let i = 0; i < x.length; i++) xsq[i] = x[i] * x[i]
  const m2 = tsMean(xsq, w)
  const out = new Float64Array(x.length)
  for (let i = 0; i < out.length; i++) {
    out[i] = Math.sqrt(Math.max(m2[i] - m[i] * m[i], 0))
  }
  return out
}

function tsExtrema(x: Vec, w: number, isMax: boolean): Vec {
  const n = x.length
  const out = new Float64Array(n)
  for (let t = 0; t < n; t++) {
    const lo = Math.max(0, t - w + 1)
    let v = x[lo]
    for (let i = lo + 1; i <= t; i++) v = isMax ? Math.max(v, x[i]) : Math.min(v, x[i])
    out[t] = v
  }
  return out
}

function tsRank(x: Vec, w: number): Vec {
  const n = x.length
  const out = new Float64Array(n)
  for (let t = 0; t < n; t++) {
    const lo = Math.max(0, t - w + 1)
    let c = 0
    for (let i = lo; i <= t; i++) if (x[i] <= x[t]) c++
    out[t] = c / (t - lo + 1)
  }
  return out
}

function tsZscore(x: Vec, w: number): Vec {
  const m = tsMean(x, w)
  const s = tsStd(x, w)
  const out = new Float64Array(x.length)
  for (let i = 0; i < out.length; i++) out[i] = (x[i] - m[i]) / Math.max(s[i], 1e-8)
  return out
}

function deltaN(x: Vec, n: number): Vec {
  const out = new Float64Array(x.length)
  for (let i = n; i < x.length; i++) out[i] = x[i] - x[i - n]
  return out
}

function lagN(x: Vec, n: number): Vec {
  const out = new Float64Array(x.length)
  for (let i = n; i < x.length; i++) out[i] = x[i - n]
  return out
}

function ema(x: Vec, w: number): Vec {
  const alpha = 2 / (w + 1)
  const out = new Float64Array(x.length)
  let prev = 0
  for (let i = 0; i < x.length; i++) {
    prev = alpha * x[i] + (1 - alpha) * prev
    out[i] = prev
  }
  return out
}

/** 窗口均值/方差/协方差(部分窗口与整窗同式;population 口径 ddof=0) */
function winStats(a: Vec, b: Vec, lo: number, t: number) {
  const cnt = t - lo + 1
  let ma = 0
  let mb = 0
  let aa = 0
  let bb = 0
  let ab = 0
  for (let i = lo; i <= t; i++) {
    ma += a[i]
    aa += a[i] * a[i]
    mb += b[i]
    bb += b[i] * b[i]
    ab += a[i] * b[i]
  }
  ma /= cnt
  aa /= cnt
  mb /= cnt
  bb /= cnt
  ab /= cnt
  return { ma, va: aa - ma * ma, mb, vb: bb - mb * mb, cov: ab - ma * mb, cnt }
}

function tsCorr(x: Vec, y: Vec, w: number): Vec {
  const n = x.length
  const out = new Float64Array(n)
  for (let t = 0; t < n; t++) {
    const lo = Math.max(0, t - w + 1)
    const s = winStats(x, y, lo, t)
    if (s.cnt < 2) continue
    const sa = Math.sqrt(s.va)
    const sb = Math.sqrt(s.vb)
    if (sa < 1e-9 || sb < 1e-9) continue
    out[t] = s.cov / (sa * sb)
  }
  return out
}

function tsBeta(x: Vec, y: Vec, w: number): Vec {
  // beta(x 对 y) = cov(x,y)/var(y);var≤1e-12 → 0
  const n = x.length
  const out = new Float64Array(n)
  for (let t = 0; t < n; t++) {
    const lo = Math.max(0, t - w + 1)
    const s = winStats(x, y, lo, t)
    out[t] = s.vb > 1e-12 ? s.cov / s.vb : 0
  }
  return out
}

function applyOp(kind: string, a: Vec, b: Vec | null, win = 0, nn = 0): Vec {
  const n = a.length
  const out = new Float64Array(n)
  const sign = (v: number) => (v > 0 ? 1 : v < 0 ? -1 : 0)
  switch (kind) {
    case "add":
      for (let i = 0; i < n; i++) out[i] = a[i] + b![i]
      return out
    case "sub":
      for (let i = 0; i < n; i++) out[i] = a[i] - b![i]
      return out
    case "mul":
      for (let i = 0; i < n; i++) out[i] = a[i] * b![i]
      return out
    case "div":
      for (let i = 0; i < n; i++)
        out[i] = a[i] / Math.max(Math.abs(b![i]), 1e-8) * sign(b![i] + 1e-12)
      return out
    case "min":
      for (let i = 0; i < n; i++) out[i] = Math.min(a[i], b![i])
      return out
    case "max":
      for (let i = 0; i < n; i++) out[i] = Math.max(a[i], b![i])
      return out
    case "abs":
      for (let i = 0; i < n; i++) out[i] = Math.abs(a[i])
      return out
    case "neg":
      for (let i = 0; i < n; i++) out[i] = -a[i]
      return out
    case "sign":
      for (let i = 0; i < n; i++) out[i] = sign(a[i])
      return out
    case "sqrt":
      for (let i = 0; i < n; i++) out[i] = sign(a[i]) * Math.sqrt(Math.abs(a[i]))
      return out
    case "signed_log":
      for (let i = 0; i < n; i++) out[i] = sign(a[i]) * Math.log1p(Math.abs(a[i]))
      return out
    case "sigmoid":
      for (let i = 0; i < n; i++) {
        const x = Math.max(-30, Math.min(30, a[i]))
        out[i] = 2 / (1 + Math.exp(-x)) - 1
      }
      return out
    case "tanh":
      for (let i = 0; i < n; i++) out[i] = Math.tanh(Math.max(-30, Math.min(30, a[i])))
      return out
    case "ts_crank":
    case "decay_linear":
      for (let t = 0; t < n; t++) {
        const lo = Math.max(0, t - win + 1)
        let sum = 0
        for (let i = lo; i <= t; i++) {
          sum += kind === "ts_crank" ? (a[i] < a[t] - 1e-6 * Math.max(1, Math.abs(a[t])) ? 1 : Math.abs(a[i] - a[t]) <= 1e-6 * Math.max(1, Math.abs(a[t])) ? 0.5 : 0) : a[i] * (i - lo + 1)
        }
        const count = t - lo + 1
        out[t] = kind === "ts_crank" ? 2 * sum / count - 1 : sum / (count * (count + 1) / 2)
      }
      return out
    case "ts_ma":
      return tsMean(a, win)
    case "ts_std":
      return tsStd(a, win)
    case "ts_max":
      return tsExtrema(a, win, true)
    case "ts_min":
      return tsExtrema(a, win, false)
    case "ts_rank":
      return tsRank(a, win)
    case "ts_zscore":
      return tsZscore(a, win)
    case "delta":
      return deltaN(a, nn)
    case "lag":
      return lagN(a, nn)
    case "atr_norm":
      for (let i = 0; i < n; i++)
        out[i] = sign(Math.max(Math.abs(a[i]), 1e-9)) * Math.log1p(Math.max(Math.abs(a[i]), 1e-9))
      return out
    case "corr":
      return tsCorr(a, b!, win)
    case "beta":
      return tsBeta(a, b!, win)
    case "resid": {
      const beta = tsBeta(a, b!, win)
      const ma = tsMean(a, win)
      const mb = tsMean(b!, win)
      for (let i = 0; i < n; i++) out[i] = a[i] - ma[i] - beta[i] * (b![i] - mb[i])
      return out
    }
    case "demean": {
      const m = tsMean(a, win)
      for (let i = 0; i < n; i++) out[i] = a[i] - m[i]
      return out
    }
    case "step":
      for (let i = 0; i < n; i++) out[i] = a[i] > 0 ? 1 : 0
      return out
    case "ema":
      return ema(a, win)
    default:
      throw new Error(`未知算子: ${kind}`)
  }
}

function nanToNum(x: Vec): Vec {
  for (let i = 0; i < x.length; i++) {
    const v = x[i]
    if (Number.isNaN(v)) x[i] = 0
    else if (v === Infinity) x[i] = 1
    else if (v === -Infinity) x[i] = -1
  }
  return x
}

// ── StackVM 执行(vm.py 同义移植)────────────────────────────

export const DEFAULT_NORM_WINDOW = 250

/** 因果滚动归一化(P0-2 修复口径,与 vm.py 同源):只用截至当下的历史,
 *  头部按部分窗口退化;近常数序列原样返回(交上层过滤) */
function normalizeOutput(x: Vec, window = DEFAULT_NORM_WINDOW, causal = false): Vec {
  const n = x.length
  let mean = 0
  for (let i = 0; i < n; i++) mean += x[i]
  mean /= n
  let v2 = 0
  for (let i = 0; i < n; i++) v2 += x[i] * x[i]
  const fullStd = Math.sqrt(Math.max(v2 / n - mean * mean, 0))
  if (!causal && fullStd < 1e-6) return x
  const out = new Float64Array(n)
  const m = tsMean(x, window)
  const sd = tsStd(x, window)
  for (let t = 0; t < n; t++) {
    out[t] = Math.max(-3, Math.min(3, (x[t] - m[t]) / Math.max(sd[t], 1e-8)))
  }
  return out
}

/** 栈式执行 token 序列;feat 为 [F*T] 行主序(f*T+t)。失败返回 null */
export function executeTokensCore(
  tokens: number[],
  feat: Float64Array,
  F: number,
  T: number,
): Float64Array | null {
  const stack: Vec[] = []
  for (const token of tokens) {
    if (token < FEAT_OFFSET) {
      if (token >= F) return null
      const row = new Float64Array(T)
      for (let t = 0; t < T; t++) row[t] = feat[token * T + t]
      stack.push(row)
    } else {
      const op = OPS[token - FEAT_OFFSET]
      if (!op) return null
      if (stack.length < op.arity) return null
      const args = stack.splice(stack.length - op.arity, op.arity)
      try {
        stack.push(nanToNum(applyOp(op.kind, args[0], args[1] ?? null, op.win ?? 0, op.n ?? 0)))
      } catch {
        return null
      }
    }
  }
  return stack.length === 1 ? normalizeOutput(stack[0], DEFAULT_NORM_WINDOW, tokens.some((t) => (t >= 40 && t < 64) || t >= 104)) : null
}

export function isConstantCore(factor: Vec): boolean {
  const n = factor.length
  let mean = 0
  for (let i = 0; i < n; i++) mean += factor[i]
  mean /= n
  let v2 = 0
  for (let i = 0; i < n; i++) v2 += factor[i] * factor[i]
  return Math.sqrt(Math.max(v2 / n - mean * mean, 0)) < 1e-6
}

// ── 指标(evaluate_factor 同义移植)───────────────────────────

export interface CoreMetrics {
  ann_ret: number
  sortino: number
  calmar: number
  ts_ic: number
  symmetry: number
  turnover_q: number
  oos_sortino: number
  oos_mult: number
  oos_negative: boolean
  consistency: number
  composite: number
}

function sortinoOf(pnl: Float64Array | number[], periods: number, lo = 0, hi = pnl.length): number {
  const n = hi - lo
  if (n < 2) return 0
  let mean = 0
  for (let i = lo; i < hi; i++) mean += pnl[i]
  mean /= n
  let sumDn2 = 0
  let nDn = 0
  for (let i = lo; i < hi; i++) {
    if (pnl[i] < 0) {
      sumDn2 += pnl[i] * pnl[i]
      nDn++
    }
  }
  if (nDn === 0) return mean > 0 ? 20 : 0
  const dstd = Math.sqrt(sumDn2 / nDn)
  if (dstd < 1e-9) return 0
  return Math.max(-20, Math.min(20, (mean / dstd) * Math.sqrt(periods)))
}

/** factor 为已归一化的因子序列(executeTokensCore 产物) */
export function evaluateCore(
  factor: Vec,
  ret: Vec,
  cost: number,
  periods: number,
): CoreMetrics {
  const n = factor.length
  const pos = new Float64Array(n)
  let longN = 0
  let shortN = 0
  let sumTo = 0
  const pnl = new Float64Array(n)
  let prev = 0
  for (let i = 0; i < n; i++) {
    const p = Math.tanh(Math.max(-3, Math.min(3, factor[i])))
    const pz = Math.abs(p) < 0.05 ? 0 : p
    if (pz > 0) longN++
    else if (pz < 0) shortN++
    const to = Math.abs(pz - prev)
    sumTo += to
    pnl[i] = pz * ret[i] - to * cost
    pos[i] = pz
    prev = pz
  }

  let meanPnl = 0
  for (let i = 0; i < n; i++) meanPnl += pnl[i]
  meanPnl /= n
  const ann = meanPnl * periods
  const sor = sortinoOf(pnl, periods)

  // calmar(P2-19 已修复口径:回撤基线含 0 起点)
  let cum = 0
  let peak = 0
  let dd = 0
  for (let i = 0; i < n; i++) {
    cum += pnl[i]
    if (cum > peak) peak = cum
    const d = peak - cum
    if (d > dd) dd = d
  }
  const cal = dd < 1e-9 ? (cum > 0 ? 10 : 0) : Math.max(-10, Math.min(10, ann / dd))

  // ts_ic(P0-3 已修复口径:factor[t] ↔ ret[t],ret 本就是 t→t+1 前向收益)
  const m = n - 1
  let ic = 0
  if (m >= 10) {
    let sx = 0
    let sy = 0
    let sxx = 0
    let syy = 0
    let sxy = 0
    for (let i = 0; i < m; i++) {
      const x = factor[i]
      const y = ret[i]
      sx += x
      sy += y
      sxx += x * x
      syy += y * y
      sxy += x * y
    }
    const mx = sx / m
    const my = sy / m
    const vx = sxx / m - mx * mx
    const vy = syy / m - my * my
    const sx2 = Math.sqrt(Math.max(vx, 0))
    const sy2 = Math.sqrt(Math.max(vy, 0))
    if (sx2 >= 1e-6 && sy2 >= 1e-6) {
      const cov = sxy / m - mx * my
      ic = cov / (sx2 * sy2)
    }
  }

  const dev = Math.abs(longN / n - 0.5) + Math.abs(shortN / n - 0.5)
  const sym = Math.max(-1, 1 - 2 * dev)
  const toMean = sumTo / n
  const tq = toMean < 1e-6 ? -1 : toMean <= 1 ? 0 : Math.max(-1, -(toMean - 1))

  // OOS 门控:训练段后 25%
  const oosN = Math.max(1, Math.floor(n / 4))
  const oosSor = sortinoOf(pnl, periods, n - oosN, n)
  const oosNegative = oosSor <= 0
  const oosMult = oosNegative ? 0 : Math.min(1.2, 1 + oosSor * 0.1)

  const half = Math.floor(n / 2)
  const s1 = half > 1 ? sortinoOf(pnl, periods, 0, half) : 0
  const s2 = n - half > 1 ? sortinoOf(pnl, periods, half, n) : 0
  const consist = s1 > 0 && s2 > 0 ? 0.5 : s1 * s2 < 0 ? -1 : 0

  const annTerm = Math.max(-1, Math.min(1, ann))
  // OOS 硬淘汰:负样本外 → ×0 零平台(P1-4 加性罚分经拍板不采纳,两端一致;
  // 守护测试 test_oos_zero_platform)
  const composite =
    (0.3 * annTerm + 0.15 * sor + 0.1 * cal + 0.2 * ic + 0.05 * sym + 0.05 * tq + 0.1 * consist) *
    oosMult

  return {
    ann_ret: ann,
    sortino: sor,
    calmar: cal,
    ts_ic: ic,
    symmetry: sym,
    turnover_q: tq,
    oos_sortino: oosSor,
    oos_mult: oosMult,
    oos_negative: oosNegative,
    consistency: consist,
    composite,
  }
}
