/**
 * 强弱指标 V2「形态档」前端计算内核（六档双向信号）
 *
 * 与后端 services/signal_strength_v2.py 逐位同源，由共读
 * backend/tests/fixtures/strength_v2_cases.json 的两侧测试守护；
 * 算法规格见 discuss/2026-08-31-强弱指标V2形态档设计.md 第四/五节。
 *
 * 与 V1（lib/strength-index.ts）的关键差异（V2 文档第三节「地基」）：
 * - V2 的一切判定（S 值、ΔS、body、位置、regime）一律使用**显示序列**
 *   （二次平滑 close，即 pClose），不读一次平滑 sClose —— 判定序列与
 *   图上柱子天然同一条；输出点管线与 V1 逐位同构（含首根 open 取 raw）
 * - 信号为六档：衰竭两档（预警）/ regime 翻转两档（确认）/ 中继两档
 *   （回调不破位再转向），状态机与优先级判定见 strength-v2-regime.ts
 *
 * 数值口径与 V1 完全一致（V1 文档 3.3.2）：全程 float64 不 round，
 * 仅产出点/信号值 half-up 保留 2 位。严格因果：末根信号 pending=true，
 * 已收盘 bar 的信号永不撤销。
 */

import type { KlineBar } from "@/types"
import type { StrengthPoint } from "./strength-index.ts"
import { calcATR } from "./pivot-signals.ts"
import { advanceRegime, initRegimeState, judgeTiers } from "./strength-v2-regime.ts"

/** 强弱 V2 计算参数（StrengthV2Config 的数值子集，不含开关与颜色） */
export interface StrengthV2Params {
  /** 归一化窗口（2-200），默认 14 */
  period: number
  /** 一次平滑周期（1-50），默认 3 */
  smooth: number
  /** 二次平滑周期（1-50），默认 2 —— V2 判定与显示同用此序列 */
  smooth2: number
  /** 多空滞回带半宽（1-25），默认 5：regime 翻转需越过 50±band */
  continuationBand: number
  /** 动能衰竭窗口（2-20），默认 3 */
  exhaustWindow: number
  /** 收缩比上限（0.1-1），默认 0.6 */
  shrinkRatio: number
  /** 走平实体上限（0.1-20），默认 2.0 */
  flatEps: number
  /** 段内相对位置容差（1-50）：距段峰/段谷 ≤ 此值算顶部/底部附近，默认 10 */
  zoneDrop: number
  /** 价格确认 ATR 缓冲倍数（0-5），默认 0.3 */
  priceBufferAtrMult: number
  /** ATR 周期（2-200），默认 14；预热段（ATR 为 null）中继/衰竭不触发 */
  atrPeriod: number
  /** 同档冷却根数（0-200），默认 3 */
  cooldown: number
}

/** 默认参数（StrengthV2Config 默认值的数值部分同源此处；smooth2=2 为标定结论） */
export const DEFAULT_STRENGTH_V2_PARAMS: StrengthV2Params = {
  period: 14,
  smooth: 3,
  smooth2: 2,
  continuationBand: 5,
  exhaustWindow: 4,
  shrinkRatio: 0.45,
  flatEps: 1.2,
  zoneDrop: 10,
  priceBufferAtrMult: 0.3,
  atrPeriod: 14,
  cooldown: 8,
}

/** 多空 regime：滞回带 [50−band, 50+band] 内保持原态，序列初始为 none */
export type StrengthRegime = "none" | "up" | "down"

/** 六档信号 id（V2 文档 4.1：三级递进 × 双向对称） */
export type StrengthV2Kind =
  | "bottom_exhaust"
  | "top_exhaust"
  | "rebound"
  | "breakdown"
  | "continuation_long"
  | "continuation_short"

/** V2 进场信号 */
export interface StrengthV2Signal {
  time: string
  /** 触发 bar 在输入序列中的下标 */
  index: number
  kind: StrengthV2Kind
  /** 触发时的强弱值（= 显示序列 close，保留 2 位；与图上柱子同一条） */
  value: number
  /** 末根（形成中）信号 —— 未收盘确认，可能消失 */
  pending: boolean
}

/** 计算输出：副图点序列 + 六档信号 + 逐点 regime（策略快照与滞回验收用） */
export interface StrengthV2Result {
  points: StrengthPoint[]
  signals: StrengthV2Signal[]
  /** 每个输出点处理完 ①② 后的 regime（与 points 等长） */
  regimes: StrengthRegime[]
}

/** half-up 保留 2 位（与后端 math.floor(x*100+0.5)/100 同口径；勿用 toFixed） */
export function round2(x: number): number {
  return Math.round(x * 100) / 100
}

/**
 * 计算强弱指标 V2。输出点与判定同用二次平滑序列（V2 文档第三节）；
 * 状态机（strength-v2-regime.ts）按 4.3/4.5 实现，两套下标约定见 4.3.1
 * （k 为 S 序列下标，i = first + k 为 bar 下标；ATR/low/high 用 bar 下标）。
 */
export function calcStrengthV2(
  bars: KlineBar[],
  params: StrengthV2Params,
): StrengthV2Result {
  const n = bars.length
  const first = params.period - 1
  if (n <= first) return { points: [], signals: [], regimes: [] }

  const alpha = 1 / params.smooth
  const beta = 1 / params.smooth2
  const count = n - first

  // —— 管线（与 V1 strength-index.ts 逐位同构）：raw → 一次 → 二次 → 点 ——
  const sClose = new Array<number>(count)
  const pClose = new Array<number>(count)
  const points: StrengthPoint[] = []

  for (let k = 0; k < count; k++) {
    const i = first + k
    const bar = bars[i]
    // 归一化窗口 [i-period+1, i]：range==0（一字板/极端停滞）取 50
    let hh = -Infinity
    let ll = Infinity
    for (let j = i - params.period + 1; j <= i; j++) {
      if (bars[j].high > hh) hh = bars[j].high
      if (bars[j].low < ll) ll = bars[j].low
    }
    const range = hh - ll
    const rawClose = range === 0 ? 50 : ((bar.close - ll) / range) * 100
    const rawHigh = range === 0 ? 50 : ((bar.high - ll) / range) * 100
    const rawLow = range === 0 ? 50 : ((bar.low - ll) / range) * 100
    const rawOpen = range === 0 ? 50 : ((bar.open - ll) / range) * 100

    // 一次平滑：主序列递归；open/high/low 复用同一个上一状态 S[i-1]
    let sC: number
    let sH: number
    let sL: number
    if (k === 0) {
      sC = rawClose
      sH = rawHigh
      sL = rawLow
    } else {
      const prev = sClose[k - 1]
      sC = alpha * rawClose + (1 - alpha) * prev
      sH = alpha * rawHigh + (1 - alpha) * prev
      sL = alpha * rawLow + (1 - alpha) * prev
    }
    sClose[k] = sC

    // 二次平滑：同结构再走一遍；首根直接承接一次平滑值（open 取 raw）
    let pC: number
    if (k === 0) {
      pC = sC
      points.push({
        time: bar.time,
        open: round2(rawOpen),
        high: round2(sH),
        low: round2(sL),
        close: round2(sC),
      })
    } else {
      const prevP = pClose[k - 1]
      pC = beta * sC + (1 - beta) * prevP
      const pH = beta * sH + (1 - beta) * prevP
      const pL = beta * sL + (1 - beta) * prevP
      // 蜡烛连续：open[i] = 二次平滑 close[i-1]
      points.push({
        time: bar.time,
        open: round2(prevP),
        high: round2(pH),
        low: round2(pL),
        close: round2(pC),
      })
    }
    pClose[k] = pC
  }

  // —— 状态机 + 六档信号（判定一律用 pClose；ATR 为 bar 下标，预热为 null）——
  const atrArr = calcATR(bars, params.atrPeriod)
  const signals: StrengthV2Signal[] = []
  const regimes: StrengthRegime[] = []
  const rstate = initRegimeState()

  for (let k = 0; k < count; k++) {
    const i = first + k
    const s = pClose[k]
    // 价格确认用「本根之前」的段内极值快照（不含本根自身影线，4.6；
    // 若含本根，low[i] ≥ min(…, low[i]) − buf 恒成立，价格拒绝无法构造）
    const pullbackLowBefore = rstate.pullbackLowPrice
    const reboundHighBefore = rstate.reboundHighPrice

    const regimeFlipped = advanceRegime(rstate, s, bars[i], params)
    regimes.push(rstate.regime)
    if (k < 2) continue

    const signal = judgeTiers(rstate, {
      s,
      d: s - pClose[k - 1],
      dPrev: pClose[k - 1] - pClose[k - 2],
      bar: bars[i],
      pClose,
      atr: atrArr[i],
      pullbackLowBefore,
      reboundHighBefore,
      k,
      i,
      regimeFlipped,
      params,
      isLastBar: i === n - 1,
    })
    if (signal) signals.push(signal)
  }

  return { points, signals, regimes }
}
