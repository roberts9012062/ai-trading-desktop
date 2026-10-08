import { calcPivotSignals, type PivotSignalPoint } from "@/lib/pivot-signals"
import type { Bar, Direction } from "./rules"

export const PIVOT_VERSION = "hunter-pivot" as const
export interface HunterPivotParams {
  alternate: boolean; left: number; right: number; min_right_live: number;
  min_amplitude_pct: number; min_atr_mult: number; atr_period: number;
  reverse_entry?: boolean;
}
export const DEFAULT_PIVOT_PARAMS: HunterPivotParams = {
  alternate: true, left: 3, right: 3, min_right_live: 1,
  min_amplitude_pct: 1.0, min_atr_mult: 1.0, atr_period: 14,
  reverse_entry: false,
}

/** Same fractal calculation and confirmation-relative entry window as quant. */
export function pivotEntry(rows: Bar[], now: number, params = DEFAULT_PIVOT_PARAMS, direction: Direction = "long") {
  const unique = [...new Map(rows.map(b => [b[0], b])).values()].sort((a, b) => a[0]-b[0])
  if (unique.some((b, i) => b.length < 6 || !b.slice(0, 6).every(Number.isFinite) || b[0]/1000 > now
    || Math.min(...b.slice(1, 5)) <= 0 || b[2] < Math.max(b[1], b[4]) || b[3] > Math.min(b[1], b[4])
    || b[5] < 0 || (i > 0 && b[0]-unique[i-1][0] !== 3600000))) return null
  const formal = params.min_right_live === params.right
  const bars = unique.slice(-240).filter(b => !formal || b[0]/1000+3600 <= now).map(b => ({
    time: new Date(b[0]).toISOString(), open: b[1], high: b[2], low: b[3], close: b[4], volume: b[5],
    is_closed: b[0]/1000+3600 <= now,
  }))
  const last = bars.at(-1)
  if (!last || Date.parse(last.time)/1000 !== Math.floor(now/3600)*3600-(formal ? 3600 : 0)) return null
  const point = calcPivotSignals(bars, params.left, params.right, {
    alternate: params.alternate, minRightLive: params.min_right_live,
    minAmplitudePct: params.min_amplitude_pct, minAtrMult: params.min_atr_mult, atrPeriod: params.atr_period,
  }).at(-1)
  if (!point) return null
  const tradeSide = params.reverse_entry === true ? (point.side === "long" ? "short" : "long") : point.side
  if (tradeSide !== direction) return null
  const age = bars.length-1-point.index-params.min_right_live
  if (age < 0 || age > 2) return null
  const signal_at = Date.parse(point.time)/1000
  const expires_at = signal_at+(params.min_right_live+(formal ? 4 : 3))*3600
  return now < expires_at ? { signal_at, expires_at, point } : null
}

export interface PivotEvidence {
  candles: { time: string; open: number; high: number; low: number; close: number; volume: number }[];
  pivot: PivotSignalPoint;
}

export interface PivotConfirmation { direction: Direction; time: string; open: number; close: number; previous_close: number }
export function pivotConfirmation(rows: Bar[], now: number, signal: { signal_at: number; point?: PivotSignalPoint }, direction: Direction): { confirmation: PivotConfirmation | null; reason: string | null } {
  direction = signal.point?.side ?? direction
  const bars = [...new Map(rows.map(b => [b[0], b])).values()].sort((a, b) => a[0]-b[0])
  const i = bars.findLastIndex(b => b[0]/1000+3600 <= now)
  if (i <= 0 || bars[i][0]/1000 <= signal.signal_at) return { confirmation: null, reason: "枢轴右侧尚无已收盘反转K线，等待确认" }
  const b = bars[i], prev = bars[i-1], sign = direction === "long" ? 1 : -1
  if (sign*(b[4]-b[1]) <= 0 || sign*(b[4]-prev[4]) <= 0) return { confirmation: null, reason: direction === "long" ? "波谷右侧仍为阴线或未收盘转强，跳过做多" : "波峰右侧仍为阳线或未收盘转弱，跳过做空" }
  if (sign*(bars.at(-1)![4]-b[4]) < 0) return { confirmation: null, reason: "报价已回到反转确认收盘价的不利一侧，跳过枢轴入场" }
  return { confirmation: { direction, time: new Date(b[0]).toISOString(), open: b[1], close: b[4], previous_close: prev[4] }, reason: null }
}
