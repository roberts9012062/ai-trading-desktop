/**
 * 总收益横向柱：一任务一柱
 */

import type { ProfitCloseBar } from "@/lib/ai-trading-api"

/** 国内期货：红涨绿跌 */
export const PROFIT_UP_COLOR = "rgba(239, 68, 68, 0.88)"
export const PROFIT_DOWN_COLOR = "rgba(34, 197, 94, 0.88)"
export const PROFIT_FLAT_COLOR = "rgba(156, 163, 175, 0.45)"

export interface ProfitTaskBar {
  taskId: string
  name: string
  symbol: string
  symbolName: string
  realized: number
  unrealized: number
  totalPnl: number
  hasOpen: boolean
  status: string
  icon: string | null
  modelId: string | null
  modelDisplayName: string | null
  providerName: string | null
  strategyType: string
  raw: ProfitCloseBar
}

export function formatProfitAmount(v: number): string {
  const n = Number.isFinite(v) ? v : 0
  const sign = n > 0 ? "+" : ""
  return `${sign}${n.toFixed(2)}`
}

export function colorForPnl(value: number): string {
  if (value > 0) return PROFIT_UP_COLOR
  if (value < 0) return PROFIT_DOWN_COLOR
  return PROFIT_FLAT_COLOR
}

/** 接口条目 → 任务柱 */
export function buildTaskProfitBars(items: ProfitCloseBar[]): ProfitTaskBar[] {
  return items.map((bar) => {
    const unrealized = Number(
      bar.unrealized != null ? bar.unrealized : bar.pnl,
    )
    const totalPnl = Number(
      bar.total_pnl != null ? bar.total_pnl : bar.cumulative,
    )
    const realized = Number(
      bar.realized != null
        ? bar.realized
        : Number.isFinite(totalPnl - unrealized)
          ? totalPnl - unrealized
          : 0,
    )
    return {
      taskId: bar.task_id || bar.id,
      name: bar.task_name || bar.symbol,
      symbol: bar.symbol,
      symbolName: bar.symbol_name || bar.symbol,
      realized: Number.isFinite(realized) ? realized : 0,
      unrealized: Number.isFinite(unrealized) ? unrealized : 0,
      totalPnl: Number.isFinite(totalPnl) ? totalPnl : 0,
      hasOpen: Boolean(bar.has_open_position || bar.filled_qty > 0),
      status: String(bar.status || ""),
      icon: bar.icon ?? null,
      modelId: bar.model_id ?? null,
      modelDisplayName: bar.model_display_name ?? null,
      providerName: bar.provider_name ?? null,
      strategyType: String(bar.strategy_type || "ai"),
      raw: bar,
    }
  })
}

/** 横向柱宽度（相对最大绝对值，至少 4% 可见） */
export function barWidthPct(value: number, maxAbs: number): number {
  if (!Number.isFinite(value) || maxAbs <= 0) return 0
  if (Math.abs(value) < 1e-9) return 0
  return Math.max(4, Math.min(100, (Math.abs(value) / maxAbs) * 100))
}
