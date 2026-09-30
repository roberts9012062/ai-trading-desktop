/**
 * 短线求值器 —— token 栈式 VM + causal_v2 输出归一化 + tanh 打分。
 *
 * 镜像 pykernel vm.execute 语义：token<64 特征、64-114 算子、115-122 v4 特征；
 * 每算子后 NaN/Inf 清理；52+ 族（含 v4）中段 NaN 缺口拒绝（返回 null）。
 * 输出 zscore 窗 = normWindowForBars（v2 口径），score = tanh(clip(z,±3))。
 * 重放器与流式预览共用（禁止第二套）。
 */

import { computeLiveFeatures, normWindowForBars } from "./features"
import type { ShortlineBar } from "./forming-bar"
import { FEAT_OFFSET, nanToNum, OPS, Series } from "./ops"
import { SHORTLINE_TOKEN_OFFSET, factorToScore } from "./spec"

export interface ChampionFormula {
  /** 桌面 token 编码（v3/v4） */
  tokens: readonly number[]
}

/** 公式引用的 feature id 集合（token <64 或 ≥115） */
export function formulaFeatures(tokens: readonly number[]): Set<number> {
  const out = new Set<number>()
  for (const t of tokens) {
    if (t >= SHORTLINE_TOKEN_OFFSET) out.add(t)
    else if (t < FEAT_OFFSET) out.add(t)
  }
  return out
}

/** 结构校验（镜像 vm.validate 的栈深/元数约束；返回 null = 合法） */
export function validateTokens(tokens: readonly number[]): string | null {
  if (!tokens.length || tokens.length > 32) return "公式长度需 1..32"
  let sp = 0
  for (const t of tokens) {
    if (!Number.isInteger(t) || t < 0) return "token 非法"
    if (t < FEAT_OFFSET || t >= SHORTLINE_TOKEN_OFFSET) {
      sp++
      if (sp > 8) return "栈深超限"
    } else {
      const op = OPS[t - FEAT_OFFSET]
      if (!op) return "未知算子"
      if (sp < op.arity) return "栈下溢"
      sp -= op.arity - 1
    }
  }
  return sp === 1 ? null : "终态栈深非 1"
}

/** 52+/v4 族的缺失准入：仅容忍头部 NaN（首个有效前；中段缺口拒绝） */
function seriesAdmissible(row: Series): boolean {
  let seenGood = false
  for (let i = 0; i < row.length; i++) {
    const v = row[i]!
    if (Number.isFinite(v)) seenGood = true
    else if (seenGood && Number.isNaN(v)) return false
  }
  return true
}

/** causal_v2 输出归一化：滚动 zscore clip ±3（近常数原样返回语义由调用方过滤） */
function normalizeOutputCausal(x: Series, window: number): Series {
  const n = x.length
  const out = new Float64Array(n)
  // cumsum 口径 tsMean/tsStd
  const c = new Float64Array(n + 1), c2 = new Float64Array(n + 1)
  for (let i = 0; i < n; i++) {
    c[i + 1] = c[i] + x[i]!
    c2[i + 1] = c2[i] + x[i]! * x[i]!
  }
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - window + 1)
    const len = i - lo + 1
    const mean = (c[i + 1] - c[lo]) / len
    const variance = Math.max((c2[i + 1] - c2[lo]) / len - mean * mean, 0)
    const std = Math.sqrt(variance)
    out[i] = Math.min(Math.max((x[i]! - mean) / Math.max(std, 1e-8), -3), 3)
  }
  return out
}

/**
 * 对 [closed…, forming] 窗口打分一组冠军，返回各冠军 score（tanh）。
 * normWindow 按 v2 头部间距推导（与引擎一致）。
 */
export function scoreAtWindow(
  bars: readonly ShortlineBar[],
  champions: readonly ChampionFormula[],
): { scores: Array<number | null>, zValues: Array<number | null>, normWindow: number } {
  const wanted = new Set<number>()
  for (const ch of champions) for (const f of formulaFeatures(ch.tokens)) wanted.add(f)
  const features = computeLiveFeatures(bars, wanted)
  const normWindow = normWindowForBars(bars)
  const scores: Array<number | null> = []
  const zValues: Array<number | null> = []
  for (const ch of champions) {
    const series = evaluateFormulaSeries(ch.tokens, features, normWindow)
    if (series === null) {
      scores.push(null); zValues.push(null); continue
    }
    const z = series[series.length - 1]!
    zValues.push(z)
    scores.push(factorToScore(z))
  }
  return { scores, zValues, normWindow }
}

/** 栈式执行整序列 + causal_v2 归一化；非法/数据缺口 → null */
export function evaluateFormulaSeries(
  tokens: readonly number[],
  features: Map<number, Series>,
  normWindow: number,
): Series | null {
  const stack: Series[] = []
  for (const token of tokens) {
    if (token < FEAT_OFFSET || token >= SHORTLINE_TOKEN_OFFSET) {
      const row = features.get(token)
      if (!row) return null
      if ((token >= 52 || token >= SHORTLINE_TOKEN_OFFSET) && !seriesAdmissible(row)) return null
      stack.push(row)
    } else {
      const op = OPS[token - FEAT_OFFSET]!
      if (stack.length < op.arity) return null
      const args = stack.splice(stack.length - op.arity, op.arity)
      stack.push(nanToNum(op.apply(args)))
    }
  }
  if (stack.length !== 1) return null
  return normalizeOutputCausal(stack[0]!, normWindow)
}
