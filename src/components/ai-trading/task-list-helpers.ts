/**
 * 任务列表展示辅助：状态、策略标签、实时浮盈
 */

import type { AITradingTask } from "@/lib/ai-trading-api"
import { QUANT_KIND_OPTIONS } from "@/lib/quant-strategy"

export const STATUS_STYLE: Record<string, string> = {
  running: "bg-emerald-500/15 text-emerald-400",
  paused: "bg-amber-500/15 text-amber-400",
  market_closed: "bg-sky-500/15 text-sky-400",
  stopped: "bg-zinc-500/15 text-zinc-400",
}

export const STATUS_LABEL: Record<string, string> = {
  running: "运行中",
  paused: "已暂停",
  market_closed: "休市暂停",
  stopped: "已结束",
}

export const SIDE_LABEL: Record<string, string> = {
  long_only: "只做多",
  short_only: "只做空",
  both: "多空",
}

export function statusKey(task: AITradingTask): string {
  if (task.status === "paused" && task.pause_reason === "market_closed") {
    return "market_closed"
  }
  return task.status
}

export interface LivePnlView {
  direction: string | null
  qty: number
  avg: number | null
  last: number | null
  pnl: number
  hasPosition: boolean
}

/**
 * 任务品种实时持仓浮盈
 * - 无仓：固定 0
 * - 有仓：优先 position_unrealized，WS 最新价按价差比例缩放
 */
export function livePnl(
  task: AITradingTask,
  lastLive: number | undefined,
): LivePnlView {
  const direction =
    task.position_direction === "long" || task.position_direction === "short"
      ? task.position_direction
      : null
  const qty = Number(task.position_qty || 0)
  const avg =
    task.position_avg_price != null &&
    Number.isFinite(Number(task.position_avg_price))
      ? Number(task.position_avg_price)
      : null
  const serverLast =
    task.position_last_price != null &&
    Number.isFinite(Number(task.position_last_price))
      ? Number(task.position_last_price)
      : null
  const hasPosition = Boolean(direction && qty > 0 && avg != null)

  if (!hasPosition) {
    return {
      direction: null,
      qty: 0,
      avg: null,
      last: null,
      pnl: 0,
      hasPosition: false,
    }
  }

  const last =
    lastLive && lastLive > 0
      ? lastLive
      : serverLast && serverLast > 0
        ? serverLast
        : avg!
  const serverPnl = Number(task.position_unrealized ?? task.cash_delta ?? 0)

  if (
    serverLast != null &&
    serverLast > 0 &&
    Math.abs(serverLast - avg!) > 1e-9 &&
    Math.abs(last - serverLast) > 1e-9
  ) {
    const serverMove =
      direction === "long" ? serverLast - avg! : avg! - serverLast
    const liveMove = direction === "long" ? last - avg! : avg! - last
    if (Math.abs(serverMove) > 1e-9) {
      return {
        direction,
        qty,
        avg,
        last,
        pnl: serverPnl * (liveMove / serverMove),
        hasPosition: true,
      }
    }
  }

  return {
    direction,
    qty,
    avg,
    last,
    pnl: serverPnl,
    hasPosition: true,
  }
}

export function strategyLabel(task: AITradingTask): string {
  const base = baseStrategyLabel(task)
  // 量化任务启用快频间隔时标注节奏（分钟/小时）；0=跟随K线收盘不标
  const sec = Number(task.quant_interval_sec ?? 0)
  if (sec > 0 && isQuantType(task.strategy_type)) {
    const min = Math.round(sec / 60)
    const pace = min >= 60 ? `${(min / 60).toFixed(min % 60 ? 1 : 0)}小时` : `${min}分钟`
    return `${base}·${pace}`
  }
  return base
}

/** 是否量化策略任务（与 quant-strategy 的 QUANT_KIND_OPTIONS 同源） */
function isQuantType(strategyType: string | null | undefined): boolean {
  if (!strategyType) return false
  return QUANT_KIND_OPTIONS.some(
    (o) => o.value === String(strategyType).toLowerCase(),
  )
}

function baseStrategyLabel(task: AITradingTask): string {
  if (task.strategy_type === "decision") {
    const sec = Number(task.decision_interval_sec ?? 60)
    return `决策·${Math.round(sec / 60)}分钟`
  }
  if (task.strategy_type === "ma_cross") {
    const p = (task.strategy_params || {}) as {
      fast_period?: number
      slow_period?: number
      ma_type?: string
    }
    return `量化·${(p.ma_type || "sma").toUpperCase()}${p.fast_period ?? 5}/${p.slow_period ?? 20}`
  }
  if (task.strategy_type === "n_breakout") {
    const p = (task.strategy_params || {}) as { lookback?: number }
    return `量化·突破${p.lookback ?? 20}日`
  }
  if (task.strategy_type === "swing_pivot") {
    const p = (task.strategy_params || {}) as {
      left?: number
      right?: number
      min_right_live?: number
    }
    // P 段 = 盘中预确认最少右侧根数（旧任务缺键时省略）
    const live = p.min_right_live
    return `量化·枢轴L${p.left ?? 3}/R${p.right ?? 3}${live ? `/P${live}` : ""}`
  }
  if (task.strategy_type === "swing_pivot_v2") {
    const p = (task.strategy_params || {}) as {
      left?: number
      right?: number
      wick_atr_mult?: number
    }
    // V2 量价拒绝：W 段 = 上攻失败深度（×ATR）
    return `量化·枢轴V2·L${p.left ?? 3}/R${p.right ?? 3}/W${p.wick_atr_mult ?? 0.8}`
  }
  if (task.strategy_type === "strength_entry") {
    const p = (task.strategy_params || {}) as {
      period?: number
      exit_threshold?: number
    }
    return `量化·强弱P${p.period ?? 14}/离${p.exit_threshold ?? 50}`
  }
  if (task.strategy_type === "strength_entry_v2") {
    const p = (task.strategy_params || {}) as {
      period?: number
      zone_drop?: number
      cooldown?: number
    }
    return `量化·强弱V2·P${p.period ?? 14}/段${p.zone_drop ?? 10}/鲜${p.cooldown ?? 3}`
  }
  return task.model_display_name || task.model_id || "AI"
}

export function qtyLabel(task: AITradingTask): string {
  const lo = Number(task.qty_min ?? task.fixed_qty ?? 1)
  const hi = Number(task.qty_max ?? lo)
  const range = lo === hi ? `${lo}手` : `${lo}-${hi}手`
  if (task.position_mode === "fixed_qty") return range
  if (task.position_mode === "half") return `半仓·${range}`
  if (task.position_mode === "full") return `全仓·${range}`
  if (task.position_mode === "scale_in") return `滚仓·${range}`
  return range
}

/** 胜率标签：胜率% (胜/总)。无交易记录返回 "--" */
export function winRateLabel(task: AITradingTask): string {
  const total = Number(task.trade_count ?? 0)
  if (total <= 0) return "胜率 --"
  const rate = Number(task.win_rate ?? 0)
  const win = Number(task.win_count ?? 0)
  return `胜率 ${rate.toFixed(1)}% (${win}/${total})`
}

/** 交易周期标签：持仓 N 天 */
export function holdDaysLabel(task: AITradingTask): string {
  const d = Number(task.max_hold_days ?? 0)
  return d > 0 ? `周期${d}天` : ""
}

/**
 * 实际运行时长标签：累计 runtime_seconds + 当前进行段（仅 running），
 * 扣除手动/休市暂停段。格式：<1h→Xm；<24h→Xh Ym；≥24h→Xd Yh。
 * 无数据返回 ""。
 */
export function runtimeLabel(task: AITradingTask): string {
  let seconds = Number(task.runtime_seconds ?? 0)
  if (task.status === "running" && task.run_started_at) {
    const start = Date.parse(task.run_started_at)
    if (Number.isFinite(start)) {
      seconds += Math.max(0, Math.floor((Date.now() - start) / 1000))
    }
  }
  if (seconds <= 0) return ""
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (h >= 24) {
    const d = Math.floor(h / 24)
    return `运行 ${d}d ${h % 24}h`
  }
  if (h >= 1) return `运行 ${h}h ${m}m`
  return `运行 ${m}m`
}
