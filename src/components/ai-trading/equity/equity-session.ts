/**
 * 收益图横轴会话
 *
 * - live（实盘）：交易日 夜 21:00 → 次日 15:00；15:10 重置
 * - virtual（虚拟盘）：自然日 00:00 → 24:00（次日 0 点）；过零点切下一日重跑
 */

export type EquityAxisMode = "live" | "virtual"

const BJ_OFFSET_MS = 8 * 60 * 60 * 1000

const RESET_HOUR = 15
const RESET_MINUTE = 10

export interface TradeSessionRange {
  fromSec: number
  toSec: number
  nowSec: number
  label: string
  closed: boolean
  notStarted: boolean
  chartZero: boolean
  /** 轴模式 */
  axisMode: EquityAxisMode
}

function bjParts(nowMs: number): {
  y: number
  m: number
  d: number
  totalMin: number
} {
  const bj = new Date(nowMs + BJ_OFFSET_MS)
  return {
    y: bj.getUTCFullYear(),
    m: bj.getUTCMonth() + 1,
    d: bj.getUTCDate(),
    totalMin: bj.getUTCHours() * 60 + bj.getUTCMinutes(),
  }
}

function bjHmToUnix(
  y: number,
  m: number,
  d: number,
  hour: number,
  minute: number,
): number {
  return Math.floor(Date.UTC(y, m - 1, d, hour - 8, minute, 0, 0) / 1000)
}

function addDays(
  y: number,
  m: number,
  d: number,
  delta: number,
): { y: number; m: number; d: number } {
  const t = Date.UTC(y, m - 1, d) + delta * 86400000
  const dt = new Date(t)
  return {
    y: dt.getUTCFullYear(),
    m: dt.getUTCMonth() + 1,
    d: dt.getUTCDate(),
  }
}

function resolveOpenDay(
  y: number,
  m: number,
  d: number,
  totalMin: number,
): { y: number; m: number; d: number } {
  const resetMin = RESET_HOUR * 60 + RESET_MINUTE
  if (totalMin >= 21 * 60) {
    return { y, m, d }
  }
  if (totalMin >= resetMin) {
    return { y, m, d }
  }
  return addDays(y, m, d, -1)
}

function getLiveTradeSessionRange(nowMs: number): TradeSessionRange {
  const p = bjParts(nowMs)
  const open = resolveOpenDay(p.y, p.m, p.d, p.totalMin)
  const close = addDays(open.y, open.m, open.d, 1)
  const fromSec = bjHmToUnix(open.y, open.m, open.d, 21, 0)
  const toSec = bjHmToUnix(close.y, close.m, close.d, 15, 0)
  const rawNow = Math.floor(nowMs / 1000)

  const notStarted = rawNow < fromSec
  const closed = !notStarted && rawNow >= toSec
  const chartZero = notStarted

  let nowSec: number
  if (notStarted) {
    nowSec = fromSec
  } else if (closed) {
    nowSec = toSec
  } else {
    nowSec = Math.min(Math.max(rawNow, fromSec), toSec)
  }

  const pad = (n: number) => String(n).padStart(2, "0")
  const rangeText = `${pad(open.m)}-${pad(open.d)} 21:00 → ${pad(close.m)}-${pad(close.d)} 15:00`

  let phaseText = "停盘走平"
  if (notStarted) {
    phaseText = "15:10 已重置 X 轴 · 等待 21:00 开盘"
  } else if (closed) {
    phaseText = "已收盘 · 15:10 重置下一交易日 X 轴"
  } else {
    phaseText = "盘中"
  }

  return {
    fromSec,
    toSec,
    nowSec,
    label: `${rangeText} · ${phaseText}`,
    closed,
    notStarted,
    chartZero,
    axisMode: "live",
  }
}

/**
 * 虚拟盘：当日 00:00 → 24:00（次日 0 点）固定日轴
 * 过零点后自动切到下一日，AI 曲线从 0 点重新起跑
 */
function getVirtualDayRange(nowMs: number): TradeSessionRange {
  const p = bjParts(nowMs)
  const next = addDays(p.y, p.m, p.d, 1)
  const fromSec = bjHmToUnix(p.y, p.m, p.d, 0, 0)
  const toSec = bjHmToUnix(next.y, next.m, next.d, 0, 0)
  const rawNow = Math.floor(nowMs / 1000)
  // 刚过零点极短窗口：钉在 00:00
  const notStarted = rawNow < fromSec
  const closed = rawNow >= toSec
  const nowSec = notStarted
    ? fromSec
    : closed
      ? toSec
      : Math.min(Math.max(rawNow, fromSec), toSec)

  const pad = (n: number) => String(n).padStart(2, "0")
  const dayLabel = `${p.y}-${pad(p.m)}-${pad(p.d)}`
  const phase = closed
    ? "已到 24:00 · 即将切下一日"
    : notStarted
      ? "等待 00:00 起跑"
      : "盘中 00:00→24:00"

  return {
    fromSec,
    toSec,
    nowSec,
    label: `${dayLabel} 00:00 → 24:00 · ${phase}`,
    closed,
    notStarted,
    // 新日刚开始时 X 钉在 0 点，Y 仍可按收益分层
    chartZero: notStarted,
    axisMode: "virtual",
  }
}

/** 按盘模式取收益图横轴范围 */
export function getTradeSessionRange(
  nowMs: number = Date.now(),
  axisMode: EquityAxisMode = "live",
): TradeSessionRange {
  if (axisMode === "virtual") {
    return getVirtualDayRange(nowMs)
  }
  return getLiveTradeSessionRange(nowMs)
}

/**
 * 相对会话起点的停盘区间（仅 live）
 * virtual 7×24 无休市走平
 */
export function closedGaps(
  axisMode: EquityAxisMode = "live",
): Array<[number, number]> {
  if (axisMode === "virtual") {
    return []
  }
  const m = (h: number, mi: number) => h * 3600 + mi * 60
  return [
    [m(5, 30), m(12, 0)],
    [m(14, 30), m(16, 30)],
  ]
}
