import { calcPivotSignals, type PivotSignalPoint } from "@/lib/pivot-signals"
import type { Bar, Direction } from "./rules"

export const PIVOT_VERSION = "hunter-pivot" as const
export interface HunterPivotParams {
  alternate: boolean; left: number; right: number; min_right_live: number;
  min_amplitude_pct: number; min_atr_mult: number; atr_period: number;
}
export const DEFAULT_PIVOT_PARAMS: HunterPivotParams = {
  alternate: true, left: 3, right: 3, min_right_live: 1,
  min_amplitude_pct: 1.5, min_atr_mult: 1.5, atr_period: 14,
}

/** Same fractal calculation and two-bar entry window as quant pivot. */
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
  if (!point || point.side !== direction || bars.length-1-point.index > 2) return null
  const signal_at = Date.parse(point.time)/1000
  const expires_at = signal_at+(formal ? 4 : 3)*3600
  return now < expires_at ? { signal_at, expires_at, point } : null
}

export interface PivotEvidence {
  candles: { time: string; open: number; high: number; low: number; close: number; volume: number }[];
  pivot: PivotSignalPoint;
}
