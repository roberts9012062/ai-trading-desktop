/**
 * shortline_v1 合格门（TS 侧，与现有引擎门并列；拒绝原因逐条记录，0 合法）。
 *
 * 输入 = 单冠军的 cadence 重放分数流 + 对齐的 bar 收盘序列 + OOS 起点-bar。
 * 冻结阈值（实现决策文档 §5）：
 *   live 可用性（白名单特征）/ 翻转率 ≤0.15 每 bar / bar 内分数 std 中位数 ≤0.20
 *   / OOS 采样点 Spearman IC ≥0.015 / 延迟 IC ≥ 0.5×基线 IC
 * 引擎侧资格（v2 严格门/WF/封存）由引擎 qualification 负责，本门不重复。
 */

import type { ReplayResult } from "./replay"
import { isLiveToken } from "./spec"

export const SHORTLINE_GATE = {
  flipPerBarCap: 0.15,
  stabilityCap: 0.20,
  sampledIcMin: 0.015,
  delayIcRatioMin: 0.5,
  /** 延迟鲁棒性用延迟（秒）：cadence ≤10 → 10s，否则一步 cadence */
  delaySeconds: 10,
} as const

export interface ShortlineGateInput {
  tokens: readonly number[]
  /** 单冠军重放（champions 长度 1） */
  replay: ReplayResult
  /** 与重放覆盖区间对齐的 bar 收盘价（含 forming 所在 bar 的当前价） */
  barCloses: readonly number[]
  /** OOS 段起始 bar 下标（IC 只在 OOS 段计） */
  oosStartBarIndex: number
}

export interface ShortlineGateMetrics {
  flip_per_bar: number
  stability_median: number
  sampled_ic: number
  delayed_ic: number
  delay_ic_ratio: number
  bars: number
  steps: number
}

export interface ShortlineGateResult {
  passed: boolean
  reasons: string[]
  metrics: ShortlineGateMetrics
}

/** Spearman 秩相关（平均秩处理并列） */
export function spearman(x: readonly number[], y: readonly number[]): number {
  const n = x.length
  if (n < 3) return 0
  const rank = (arr: readonly number[]) => {
    const idx = arr.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0])
    const r = new Array<number>(n).fill(0)
    let i = 0
    while (i < n) {
      let j = i
      while (j + 1 < n && idx[j + 1]![0] === idx[i]![0]) j++
      const avg = (i + j) / 2 + 1
      for (let k = i; k <= j; k++) r[idx[k]![1]] = avg
      i = j + 1
    }
    return r
  }
  return pearson(rank(x), rank(y))
}

function pearson(a: readonly number[], b: readonly number[]): number {
  const n = a.length
  let ma = 0, mb = 0
  for (let i = 0; i < n; i++) { ma += a[i]!; mb += b[i]! }
  ma /= n; mb /= n
  let cxy = 0, cxx = 0, cyy = 0
  for (let i = 0; i < n; i++) {
    const da = a[i]! - ma, db = b[i]! - mb
    cxy += da * db; cxx += da * da; cyy += db * db
  }
  if (cxx <= 0 || cyy <= 0) return 0
  return cxy / Math.sqrt(cxx * cyy)
}

function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  const n = s.length
  if (!n) return 0
  return n % 2 ? s[(n - 1) / 2]! : (s[n / 2 - 1]! + s[n / 2]!) / 2
}

function sign(v: number): number {
  return v > 0 ? 1 : v < 0 ? -1 : 0
}

export function qualifyShortline(input: ShortlineGateInput): ShortlineGateResult {
  const reasons: string[] = []
  const steps = input.replay.steps
  const cadence = input.replay.options.cadence

  // 1) live 可用性
  const dead = input.tokens.filter((t) => !isLiveToken(t))
  if (dead.length) reasons.push(`feature_not_live:${dead.join(",")}`)

  // 每 step 的 (barIndex, score)
  const perStep: Array<{ bar: number, score: number | null, t: number }> = steps.map((s, i) => ({
    bar: i, // 占位，下面按 barStart 分组重编号
    score: s.scores[0] ?? null,
    t: s.t,
  }))
  // bar 下标映射：按 barStart 去重顺序编号
  const barKeys: number[] = []
  const barIndexByKey = new Map<number, number>()
  for (const s of steps) {
    if (!barIndexByKey.has(s.barStart)) {
      barIndexByKey.set(s.barStart, barKeys.length)
      barKeys.push(s.barStart)
    }
  }
  for (let i = 0; i < steps.length; i++) {
    perStep[i]!.bar = barIndexByKey.get(steps[i]!.barStart)!
  }

  const valid = perStep.filter((p) => p.score !== null) as Array<{ bar: number, score: number, t: number }>
  const barCount = barKeys.length

  // 2) 翻转率：相邻 cadence 步符号变化数 / bar 数
  let flips = 0
  for (let i = 1; i < valid.length; i++) {
    if (sign(valid[i]!.score) !== sign(valid[i - 1]!.score)) flips++
  }
  const flipPerBar = barCount > 0 ? flips / barCount : Infinity

  // 3) 打分稳定性：bar 内分数 std 的中位数
  const byBar = new Map<number, number[]>()
  for (const p of valid) {
    const list = byBar.get(p.bar) ?? []
    list.push(p.score)
    byBar.set(p.bar, list)
  }
  const stds: number[] = []
  for (const list of byBar.values()) {
    if (list.length < 2) continue
    const m = list.reduce((a, b) => a + b, 0) / list.length
    stds.push(Math.sqrt(list.reduce((a, b) => a + (b - m) * (b - m), 0) / list.length))
  }
  const stabilityMedian = stds.length ? median(stds) : Infinity

  // 4) 采样点 IC（OOS 段）：score_t vs 下一 bar 收盘收益
  const delayMs = (cadence <= SHORTLINE_GATE.delaySeconds ? SHORTLINE_GATE.delaySeconds : cadence) * 1000
  const xs: number[] = [], ys: number[] = [], xsDelayed: number[] = [], ysDelayed: number[] = []
  for (const p of valid) {
    if (p.bar < input.oosStartBarIndex || p.bar + 1 >= input.barCloses.length) continue
    const c0 = input.barCloses[p.bar]!
    const c1 = input.barCloses[p.bar + 1]!
    if (!(c0 > 0) || !(c1 > 0)) continue
    const ret = c1 / c0 - 1
    xs.push(p.score)
    ys.push(ret)
    // 延迟样本：t−delay 处的分数（存在才计入）
    const delayed = valid.find((q) => q.t === p.t - delayMs)
    if (delayed) {
      xsDelayed.push(delayed.score)
      ysDelayed.push(ret)
    }
  }
  const sampledIc = xs.length >= 20 ? spearman(xs, ys) : 0
  const delayedIc = xsDelayed.length >= 20 ? spearman(xsDelayed, ysDelayed) : 0
  const delayRatio = sampledIc > 0 ? delayedIc / sampledIc : delayedIc > 0 ? Infinity : 1

  if (flipPerBar > SHORTLINE_GATE.flipPerBarCap) reasons.push(`flip_rate:${flipPerBar.toFixed(3)}>${SHORTLINE_GATE.flipPerBarCap}`)
  if (stabilityMedian > SHORTLINE_GATE.stabilityCap) reasons.push(`stability:${stabilityMedian.toFixed(3)}>${SHORTLINE_GATE.stabilityCap}`)
  if (!(sampledIc >= SHORTLINE_GATE.sampledIcMin)) reasons.push(`sampled_ic:${sampledIc.toFixed(4)}<${SHORTLINE_GATE.sampledIcMin}`)
  if (!(delayRatio >= SHORTLINE_GATE.delayIcRatioMin)) reasons.push(`delay_robustness:${delayRatio.toFixed(3)}<${SHORTLINE_GATE.delayIcRatioMin}`)

  return {
    passed: reasons.length === 0,
    reasons,
    metrics: {
      flip_per_bar: flipPerBar,
      stability_median: stabilityMedian,
      sampled_ic: sampledIc,
      delayed_ic: delayedIc,
      delay_ic_ratio: Number.isFinite(delayRatio) ? delayRatio : 999,
      bars: barCount,
      steps: steps.length,
    },
  }
}
