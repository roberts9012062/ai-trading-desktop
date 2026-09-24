/**
 * 收益曲线数据
 * live：横轴 21:00→次日15:00；virtual：滚动近 24 小时墙钟
 */

import type { LineData, Time } from "lightweight-charts"
import type { AITradingTask, EquityPoint } from "@/lib/ai-trading-api"
import { toChartTime } from "./equity-time"
import {
  closedGaps,
  getTradeSessionRange,
  type EquityAxisMode,
} from "./equity-session"

const STEP_SEC = 15 * 60

/**
 * 对比图 Y 值：开仓后只显示「当前持仓的浮动盈亏」，
 * 不叠加历史已平仓的累计 realized，让曲线反映这笔仓位的盈亏变化。
 */
export function taskLivePnl(
  task: AITradingTask,
  _points: EquityPoint[] = [],
): number {
  const hasPos =
    (task.position_qty ?? 0) > 0 &&
    (task.position_direction === "long" ||
      task.position_direction === "short")
  // 空仓不进入对比图（taskHasOpenPosition 已过滤），此处返回 0 兜底
  if (!hasPos) return 0
  const unrealized = Number(task.position_unrealized ?? 0)
  return Number.isFinite(unrealized) ? unrealized : 0
}

/**
 * 是否当前持有仓位。仅开仓后的任务才进入「AI 模型收益对比」，
 * 空仓（含曾下单但已平仓）的任务不进入对比。
 */
export function taskHasOpenPosition(task: AITradingTask): boolean {
  if (task.has_open_position === true) return true
  if ((task.position_qty ?? 0) > 0) return true
  if (
    task.position_direction === "long" ||
    task.position_direction === "short"
  ) {
    return true
  }
  return false
}

/**
 * 历史快照 → 浮盈序列。
 * 只读 unrealized_pnl（当前持仓浮动盈亏），不读 cash_delta（=已实现+浮盈总收益），
 * 让对比图曲线只反映「当前下单的浮盈浮亏」，不把历史已平仓的 realized 叠进来。
 */
function histMap(
  points: EquityPoint[],
  fromSec: number,
  nowSec: number,
): Map<number, number> {
  const map = new Map<number, number>()
  for (const p of points) {
    const t = toChartTime(p.ts)
    if (t === null || !Number.isFinite(p.unrealized_pnl)) continue
    const sec = t as number
    if (sec < fromSec || sec > nowSec) continue
    map.set(sec, p.unrealized_pnl)
  }
  return map
}

function inClosedGap(
  sec: number,
  fromSec: number,
  axisMode: EquityAxisMode,
): boolean {
  const off = sec - fromSec
  for (const [a, b] of closedGaps(axisMode)) {
    if (off >= a && off < b) return true
  }
  return false
}

/**
 * 任务曲线
 * - live：开盘～现在，停盘走平
 * - virtual：当日 00:00→24:00，零点重跑，无休市走平
 */
export function lineForTradeSession(
  _task: AITradingTask,
  points: EquityPoint[],
  lastValue: number,
  nowMs: number = Date.now(),
  axisMode: EquityAxisMode = "live",
): LineData[] {
  const session = getTradeSessionRange(nowMs, axisMode)
  const { fromSec, nowSec, notStarted } = session
  const endValue = lastValue

  if (notStarted) {
    // 停盘等开盘（live 15:10→21:00）：X 钉在开盘时刻，Y 按当前累计收益分层显示
    return [{ time: fromSec as Time, value: endValue }]
  }

  // histMap 已按 fromSec 过滤 → 过零点后昨日点自动丢弃
  const hist = histMap(points, fromSec, nowSec)
  const out: LineData[] = []
  let lastV = 0
  let gapFlatV = 0
  const endSec = Math.max(fromSec, nowSec)

  for (let t = fromSec; t <= endSec; t += STEP_SEC) {
    const closed = inClosedGap(t, fromSec, axisMode)
    if (hist.has(t)) lastV = hist.get(t)!
    for (const [hs, hv] of hist) {
      if (hs > t - STEP_SEC && hs <= t) lastV = hv
    }
    if (t + STEP_SEC > nowSec) lastV = endValue

    if (closed) {
      const justEnter = !inClosedGap(t - STEP_SEC, fromSec, axisMode)
      if (justEnter) gapFlatV = lastV
      if (gapFlatV === 0 && lastV !== 0) gapFlatV = lastV
      lastV = gapFlatV
    } else {
      gapFlatV = lastV
    }
    out.push({ time: t as Time, value: lastV })
  }

  if (out.length === 0) {
    out.push({ time: fromSec as Time, value: endValue })
  } else {
    // 实盘开盘 / 虚拟盘 0 点：都从 0 起步，过零点后重新起跑
    out[0] = { time: fromSec as Time, value: 0 }
  }

  const lastIdx = out.length - 1
  if ((out[lastIdx].time as number) === nowSec) {
    out[lastIdx] = { time: nowSec as Time, value: endValue }
  } else {
    out.push({ time: nowSec as Time, value: endValue })
    out.sort((a, b) => (a.time as number) - (b.time as number))
  }

  return out
}

export function lineWithNowEndpoint(
  task: AITradingTask,
  points: EquityPoint[],
  lastValue: number,
  axisMode: EquityAxisMode = "live",
): LineData[] {
  return lineForTradeSession(task, points, lastValue, Date.now(), axisMode)
}
