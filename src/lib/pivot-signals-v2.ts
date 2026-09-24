/**
 * 波段枢轴信号 V2：前期高低点 + 量价拒绝形态 + 突破即假信号
 *
 * 与后端 app/services/signal_pivot_v2.py 逐字对齐 —— 同一组 bars 必须得到
 * 同一组信号，由 pivot-signals-v2.test.mjs 读共享 fixture 守护。
 * V1（pivot-signals.ts）保持不变，两者由 pivotVersion 二选一。
 *
 * ## 语义（用户口述的交易逻辑，2026-08-30 重做）
 *
 * 参考极值：最近确认的分型高点/低点（left/right，默认 3/3）。参考被突破后
 * 置空，直到新分型确认——突破期间不出该侧信号。多空两侧独立跟踪。
 *
 * 做空触发（只对已收盘 bar 评估；序列末根视为形成中，不评估）：
 * 设窗口 W = attackWindow（默认 3）根（含当前 bar）：
 * 1. 冲击到位：窗口最高价 ≥ 前期高点 R − proximity×ATR[i]
 * 2. 上攻失败：窗口最高价 − close[i] ≥ wick×ATR[i]
 *    （单K长上影线 / 多K累计冲高回落，统一为"失败深度"）
 * 3. 窗口净上攻：窗口最高价 > 窗口前一根的 high
 * 4. 量能二选一（数据存在时必须满足）：放量 ≥ expand×均量（放量拒绝）
 *    或 缩量 ≤ shrink×均量（缩量失败）；量能缺失降级为纯形态
 * 5. 冷却：距上次同侧信号 ≥ cooldown 根
 *
 * 假空（灰✕）：信号后任何已收盘 bar 的 high 突破参考高点（+可选缓冲）
 * → invalidated。做多完全镜像。严格因果、只可能 false→true，不引入重绘。
 */

import type { KlineBar } from "@/types"
import { calcATR } from "./pivot-signals.ts"

/**
 * V2 是否开放使用（图表波段版本切换器 + 量化策略选择入口共用）。
 *
 * 2026-08-31 起置 false：V2 量价拒绝引擎经用户图上复盘判定信号不达标，
 * 暂停使用——入口灰显不可选，存量 pivotVersion=v2 的用户自动回落 V1
 * （存储配置不改，恢复时原样切回）。后端算法与已创建的 swing_pivot_v2
 * 任务不受影响。恢复时把这里改回 true 即可。
 */
export const PIVOT_V2_ENABLED = false

/** V2 拒绝形态信号点 */
export interface PivotSignalPointV2 {
  time: string
  /** long=冲击低点失败做多；short=冲击高点失败做空 */
  side: "long" | "short"
  /** 参考极值价（前期高点 for short / 前期低点 for long） */
  price: number
  /** 触发 bar 的下标 */
  index: number
  /** 参考极值 bar 的下标 */
  refIndex: number
  /** wick_expand=放量拒绝；attack_shrink=缩量失败；no_volume=量能缺失降级 */
  pattern: "wick_expand" | "attack_shrink" | "no_volume"
  /**
   * 假信号标记：参考极值被突破（含缓冲）为 true。
   * 仅在 markInvalidated=true 时写入；关掉即不写。
   */
  invalidated?: boolean
  /** 首次突破参考极值的 bar index；未突破为 null */
  invalidatedAt?: number | null
}

/** V2 拒绝形态参数（left/right 作为 calcPivotSignalsV2 的位置参数传入） */
export interface PivotV2Options {
  /** 冲击到位容差（×ATR） */
  proximityAtrMult: number
  /** 上攻失败最小深度（×ATR，单K上影/多K回落共用） */
  wickAtrMult: number
  /** 多K上攻窗口根数 */
  attackWindow: number
  /** 量能急速扩大下限（×均量） */
  volExpandRatio: number
  /** 量能急速萎缩上限（×均量） */
  volShrinkRatio: number
  /** 均量窗口 */
  volMaPeriod: number
  /** 同侧信号最小间隔根数 */
  cooldown: number
  /** ATR 周期 */
  atrPeriod: number
  /** 失效标记开关（只打标不过滤），默认开 */
  markInvalidated: boolean
  /** 突破缓冲（×ATR），过滤插针噪声；0 = 严格突破 */
  invalidateAtrMult: number
}

/** 分型峰谷判定（与 V1 同口径：右侧用 >= / <= 严格比较，并列取最左） */
function isPivotAt(
  klines: KlineBar[],
  i: number,
  left: number,
  rightCount: number,
): { isHigh: boolean; isLow: boolean } {
  const hi = klines[i].high
  const lo = klines[i].low
  let isHigh = true
  let isLow = true
  for (let j = 1; j <= left; j++) {
    if (klines[i - j].high > hi) isHigh = false
    if (klines[i - j].low < lo) isLow = false
    if (!isHigh && !isLow) return { isHigh: false, isLow: false }
  }
  for (let j = 1; j <= rightCount; j++) {
    if (klines[i + j].high >= hi) isHigh = false
    if (klines[i + j].low <= lo) isLow = false
    if (!isHigh && !isLow) break
  }
  return { isHigh, isLow }
}

/**
 * 均量（窗口 [i-period+1, i]，严格因果）。窗口不满或含缺失量 → null，
 * 调用方降级为纯形态触发。
 */
function volMa(klines: KlineBar[], i: number, period: number): number | null {
  const lo = i - period + 1
  if (lo < 0) return null
  let acc = 0
  for (let j = lo; j <= i; j++) {
    const raw = klines[j].volume
    if (raw == null || !Number.isFinite(raw)) return null
    acc += raw
  }
  return acc / period
}

/**
 * 信号失效标记（就地打标，不过滤）：突破参考极值 = 假信号（假空/假多）。
 * 用 high/low 而非 close——影线穿过参考位时，挂在另一侧的止损已成交。
 */
function markInvalidated(
  point: PivotSignalPointV2,
  klines: KlineBar[],
  atrArr: (number | null)[] | null,
  atrMult: number,
): void {
  const i = point.index
  const p = point.price
  let buf = 0
  if (atrArr && atrMult > 0 && i >= 0 && i < atrArr.length) {
    const a = atrArr[i]
    if (a != null && a > 0) buf = a * atrMult
  }
  let invalidatedAt: number | null = null
  if (point.side === "short") {
    for (let j = i + 1; j < klines.length; j++) {
      if (klines[j].high > p + buf) {
        invalidatedAt = j
        break
      }
    }
  } else {
    for (let j = i + 1; j < klines.length; j++) {
      if (klines[j].low < p - buf) {
        invalidatedAt = j
        break
      }
    }
  }
  point.invalidated = invalidatedAt !== null
  point.invalidatedAt = invalidatedAt
}

/** 计算 V2 拒绝形态信号（与后端 calc_pivot_signals_v2 同逻辑） */
export function calcPivotSignalsV2(
  klines: KlineBar[],
  left: number,
  right: number,
  options: PivotV2Options,
): PivotSignalPointV2[] {
  const n = klines.length
  if (left < 1 || right < 1 || n < left + right + 1) return []

  const atr = calcATR(klines, Math.max(1, Math.floor(options.atrPeriod)))
  const win = Math.max(1, Math.floor(options.attackWindow))
  const prox = Math.max(0, options.proximityAtrMult)
  const wick = Math.max(0, options.wickAtrMult)
  const expand = Math.max(0, options.volExpandRatio)
  const shrink = Math.max(0, options.volShrinkRatio)
  const cd = Math.max(0, Math.floor(options.cooldown))
  const maPeriod = Math.max(1, Math.floor(options.volMaPeriod))

  const out: PivotSignalPointV2[] = []
  let refHigh: { price: number; index: number } | null = null
  let refLow: { price: number; index: number } | null = null
  let lastShort = -Infinity
  let lastLong = -Infinity

  for (let i = 0; i < n; i++) {
    // ① 分型确认：bar k = i - right 在此刻凑满右侧确认（因果）
    const k = i - right
    if (k >= left) {
      const { isHigh, isLow } = isPivotAt(klines, k, left, right)
      if (isHigh) refHigh = { price: klines[k].high, index: k }
      if (isLow) refLow = { price: klines[k].low, index: k }
    }

    // ② 参考被突破 → 置空（该侧在突破期间不再出信号）
    if (refHigh && klines[i].high > refHigh.price) refHigh = null
    if (refLow && klines[i].low < refLow.price) refLow = null

    // ③ 触发只评已收盘 bar：末根视为形成中
    if (i > n - 2 || i < win) continue
    const a = atr[i]
    if (a == null || a <= 0) continue

    let winHi = -Infinity
    let winLo = Infinity
    for (let j = i - win + 1; j <= i; j++) {
      if (klines[j].high > winHi) winHi = klines[j].high
      if (klines[j].low < winLo) winLo = klines[j].low
    }
    const priorHi = klines[i - win].high
    const priorLo = klines[i - win].low
    const closeI = klines[i].close

    const ma = volMa(klines, i, maPeriod)
    const volI = klines[i].volume

    // ── 空：冲击前期高点失败（放量拒绝 / 缩量失败）──
    if (
      refHigh &&
      i - lastShort >= cd &&
      winHi >= refHigh.price - prox * a &&
      winHi - closeI >= wick * a &&
      winHi > priorHi
    ) {
      let pattern: "wick_expand" | "attack_shrink" | "no_volume" | null =
        "no_volume"
      if (volI != null && Number.isFinite(volI) && ma != null && ma > 0) {
        if (volI >= expand * ma) pattern = "wick_expand"
        else if (volI <= shrink * ma) pattern = "attack_shrink"
        else pattern = null // 量能不支持 → 不触发
      }
      if (pattern !== null) {
        out.push({
          time: klines[i].time,
          side: "short",
          price: refHigh.price,
          index: i,
          refIndex: refHigh.index,
          pattern,
        })
        lastShort = i
      }
    }

    // ── 多：冲击前期低点失败（镜像）──
    if (
      refLow &&
      i - lastLong >= cd &&
      winLo <= refLow.price + prox * a &&
      closeI - winLo >= wick * a &&
      winLo < priorLo
    ) {
      let pattern: "wick_expand" | "attack_shrink" | "no_volume" | null =
        "no_volume"
      if (volI != null && Number.isFinite(volI) && ma != null && ma > 0) {
        if (volI >= expand * ma) pattern = "wick_expand"
        else if (volI <= shrink * ma) pattern = "attack_shrink"
        else pattern = null
      }
      if (pattern !== null) {
        out.push({
          time: klines[i].time,
          side: "long",
          price: refLow.price,
          index: i,
          refIndex: refLow.index,
          pattern,
        })
        lastLong = i
      }
    }
  }

  // 失效标记（只打标不过滤；关掉即不写新键）
  if (options.markInvalidated && out.length > 0) {
    const mult = Math.max(0, options.invalidateAtrMult)
    const atrInv = mult > 0 ? calcATR(klines, Math.max(1, Math.floor(options.atrPeriod))) : null
    for (const point of out) markInvalidated(point, klines, atrInv, mult)
  }
  return out
}
