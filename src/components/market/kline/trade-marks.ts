/**
 * 任务 K 线交易标记（AI 看盘行情）
 *
 * 设计目标：干净直观 ——
 * - 同一根 bar 上同类型的成交聚合成一个标记（手数求和），一根 bar 最多
 *   4 个标记：开多（bar 下方 ↑ 红「多N」）/ 开空（bar 上方 ↓ 绿「空N」）/
 *   平多（上方 ● 橙「平N」）/ 平空（下方 ● 橙「平N」）
 * - 标签紧凑无空格（多5/空3/平2），减少与相邻 bar 的重叠
 * - 明细不在图上堆砌：悬停信息面板展示该 bar 的成交明细（方向/手数/价格）
 *
 * 吸附规则：成交时间吸附最近的已加载 bar（日线夜盘成交归属次日 bar，
 * 分钟线盘中成交落回当根）。分时（tick）模式吸附分时数据点（真实 Unix 秒，
 * 与蜡烛「北京时间视为 UTC」约定不同）。标记按任务隔离，切换任务时整体重建。
 */

import {
  createSeriesMarkers,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type SeriesMarker,
  type Time,
} from "lightweight-charts"
import type { KlineBar, KlinePeriod } from "@/types"
import type { TaskTradeMark } from "@/lib/ai-trading-api"
import { formatChartTime, toTimestamp } from "./utils"

/** 标记配色（与任务预警弹窗口径一致） */
export const TRADE_MARK_COLORS = {
  long: "#ef4444", // 开多：红
  short: "#22c55e", // 开空：绿
  close: "#f59e0b", // 平仓：橙
} as const

/** 悬停明细行（KlineHoverInfoPanel 展示） */
export interface HoverTradeRow {
  label: string
  value: string
  color: string
}

/** 同一吸附键（同一根 bar / 同一分时点）上的成交分组 */
export interface MarkGroup {
  /** 图表时间（marker.time 用） */
  time: Time
  /** 图表时间键（查索引用） */
  key: string
  marks: TaskTradeMark[]
}

/** ISO 时间串 → 「北京时间墙钟」秒（与蜡烛 toTimestamp 同一约定） */
function isoToBeijingSeconds(iso: string): number | null {
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return null
  // 加 8h 后取 UTC 分量 = 北京墙钟；再视为 UTC 得到图表时间约定秒数
  const beijing = new Date(ms + 8 * 3600 * 1000)
  const y = beijing.getUTCFullYear()
  const mo = String(beijing.getUTCMonth() + 1).padStart(2, "0")
  const d = String(beijing.getUTCDate()).padStart(2, "0")
  const h = String(beijing.getUTCHours()).padStart(2, "0")
  const mi = String(beijing.getUTCMinutes()).padStart(2, "0")
  const s = String(beijing.getUTCSeconds()).padStart(2, "0")
  return toTimestamp(`${y}-${mo}-${d} ${h}:${mi}:${s}`)
}

/**
 * 成交时间 → 目标吸附点索引（最近吸附）。
 * 早于首点（历史未加载到）吸附首点。
 */
function snapToIndex(tradeSeconds: number, targets: number[]): number {
  let lo = 0
  let hi = targets.length - 1
  let floorIdx = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (targets[mid] <= tradeSeconds) {
      floorIdx = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  if (floorIdx === -1) return targets.length > 0 ? 0 : -1
  if (floorIdx === targets.length - 1) return floorIdx
  const floorDiff = tradeSeconds - targets[floorIdx]
  const ceilDiff = targets[floorIdx + 1] - tradeSeconds
  return ceilDiff < floorDiff ? floorIdx + 1 : floorIdx
}

function _qty(mark: TaskTradeMark): number {
  return Math.max(0, Math.round(Number(mark.filled_qty) || 0))
}

/**
 * 通用吸附分组：把成交按吸附点归组。
 * toSeconds 决定时间约定（蜡烛=北京视为UTC；分时=真实Unix秒）。
 */
function groupMarks(
  marks: TaskTradeMark[] | null | undefined,
  snapTargets: number[],
  toSeconds: (iso: string) => number | null,
  toKeyTime: (idx: number) => { key: string; time: Time },
): Map<string, MarkGroup> {
  const out = new Map<string, MarkGroup>()
  if (!marks || marks.length === 0 || snapTargets.length === 0) return out
  const sorted = [...snapTargets].sort((a, b) => a - b)

  for (const mark of marks) {
    if (_qty(mark) <= 0) continue
    const sec = toSeconds(String(mark.time ?? ""))
    if (sec == null) continue
    const idx = snapToIndex(sec, sorted)
    if (idx < 0) continue
    const { key, time } = toKeyTime(idx)
    const group = out.get(key)
    if (group) {
      group.marks.push(mark)
    } else {
      out.set(key, { key, time, marks: [mark] })
    }
  }
  return out
}

/** 蜡烛周期：按 bar 吸附分组 */
export function buildBarMarksIndex(
  marks: TaskTradeMark[] | null | undefined,
  bars: KlineBar[],
  period: KlinePeriod,
): Map<string, MarkGroup> {
  if (period === "tick" || !bars.length) return new Map()
  const sorted = [...bars].sort((a, b) => toTimestamp(a.time) - toTimestamp(b.time))
  const seconds = sorted.map((b) => toTimestamp(b.time))
  return groupMarks(
    marks,
    seconds,
    isoToBeijingSeconds,
    (idx) => {
      const t = formatChartTime(period, sorted[idx].time)
      return { key: String(t), time: t }
    },
  )
}

/** 分时模式：按分时数据点吸附分组（tickTimes 为真实 Unix 秒） */
export function buildTickMarksIndex(
  marks: TaskTradeMark[] | null | undefined,
  tickTimes: number[],
): Map<string, MarkGroup> {
  return groupMarks(
    marks,
    tickTimes,
    (iso) => {
      const ms = Date.parse(iso)
      return Number.isFinite(ms) ? Math.floor(ms / 1000) : null
    },
    (idx) => {
      const t = tickTimes[idx] as Time
      return { key: String(t), time: t }
    },
  )
}

/** 一组成交 → 聚合 markers（同 bar 同类型合并，标签紧凑） */
function groupToMarkers(group: MarkGroup): SeriesMarker<Time>[] {
  let longQty = 0
  let shortQty = 0
  let closeLongQty = 0
  let closeShortQty = 0
  for (const m of group.marks) {
    const qty = _qty(m)
    const dir = String(m.direction)
    const off = String(m.offset)
    if (off === "open" && dir === "buy") longQty += qty
    else if (off === "open" && dir === "sell") shortQty += qty
    else if (off === "close" && dir === "sell") closeLongQty += qty
    else if (off === "close" && dir === "buy") closeShortQty += qty
  }
  const out: SeriesMarker<Time>[] = []
  // bar 下方：开多 ↑ 红、平空 ● 橙（买入侧）
  if (longQty > 0) {
    out.push({
      time: group.time,
      position: "belowBar",
      shape: "arrowUp",
      color: TRADE_MARK_COLORS.long,
      text: `多${longQty}`,
      size: 1,
    })
  }
  if (closeShortQty > 0) {
    out.push({
      time: group.time,
      position: "belowBar",
      shape: "circle",
      color: TRADE_MARK_COLORS.close,
      text: `平${closeShortQty}`,
      size: 1,
    })
  }
  // bar 上方：开空 ↓ 绿、平多 ● 橙（卖出侧）
  if (shortQty > 0) {
    out.push({
      time: group.time,
      position: "aboveBar",
      shape: "arrowDown",
      color: TRADE_MARK_COLORS.short,
      text: `空${shortQty}`,
      size: 1,
    })
  }
  if (closeLongQty > 0) {
    out.push({
      time: group.time,
      position: "aboveBar",
      shape: "circle",
      color: TRADE_MARK_COLORS.close,
      text: `平${closeLongQty}`,
      size: 1,
    })
  }
  return out
}

/** 蜡烛周期：构造聚合 markers（按 bar 吸附，同类型合并） */
export function buildTradeMarkers(
  marks: TaskTradeMark[] | null | undefined,
  bars: KlineBar[],
  period: KlinePeriod,
): SeriesMarker<Time>[] {
  const index = buildBarMarksIndex(marks, bars, period)
  const out: SeriesMarker<Time>[] = []
  for (const group of index.values()) {
    out.push(...groupToMarkers(group))
  }
  return out
}

/** 分时模式：构造聚合 markers（按分时点吸附，同类型合并） */
export function buildTickTradeMarkers(
  marks: TaskTradeMark[] | null | undefined,
  tickTimes: number[],
): SeriesMarker<Time>[] {
  const index = buildTickMarksIndex(marks, tickTimes)
  const out: SeriesMarker<Time>[] = []
  for (const group of index.values()) {
    out.push(...groupToMarkers(group))
  }
  return out
}

/** 一组成交 → 悬停面板明细行（开多/开空/平多/平空，价格单笔或区间） */
export function summarizeGroup(group: MarkGroup | undefined): HoverTradeRow[] {
  if (!group || group.marks.length === 0) return []
  const buckets: Record<
    "openLong" | "openShort" | "closeLong" | "closeShort",
    { qty: number; prices: number[] }
  > = {
    openLong: { qty: 0, prices: [] },
    openShort: { qty: 0, prices: [] },
    closeLong: { qty: 0, prices: [] },
    closeShort: { qty: 0, prices: [] },
  }
  for (const m of group.marks) {
    const qty = _qty(m)
    if (qty <= 0) continue
    const dir = String(m.direction)
    const off = String(m.offset)
    const price = Number(m.price)
    let b: (typeof buckets)["openLong"] | null = null
    if (off === "open" && dir === "buy") b = buckets.openLong
    else if (off === "open" && dir === "sell") b = buckets.openShort
    else if (off === "close" && dir === "sell") b = buckets.closeLong
    else if (off === "close" && dir === "buy") b = buckets.closeShort
    if (!b) continue
    b.qty += qty
    if (Number.isFinite(price) && price > 0) b.prices.push(price)
  }

  const rows: HoverTradeRow[] = []
  const fmt = (b: { qty: number; prices: number[] }): string => {
    if (b.prices.length === 0) return `${b.qty}手`
    const min = Math.min(...b.prices)
    const max = Math.max(...b.prices)
    const priceText =
      min === max ? `${min}` : `${min}~${max}`
    return `${b.qty}手 @${priceText}`
  }
  if (buckets.openLong.qty > 0)
    rows.push({ label: "开多", value: fmt(buckets.openLong), color: TRADE_MARK_COLORS.long })
  if (buckets.openShort.qty > 0)
    rows.push({ label: "开空", value: fmt(buckets.openShort), color: TRADE_MARK_COLORS.short })
  if (buckets.closeLong.qty > 0)
    rows.push({ label: "平多", value: fmt(buckets.closeLong), color: TRADE_MARK_COLORS.close })
  if (buckets.closeShort.qty > 0)
    rows.push({ label: "平空", value: fmt(buckets.closeShort), color: TRADE_MARK_COLORS.close })
  return rows
}

/** 任务标记控制器：插件 + 所挂序列（蜡烛↔分时切换/序列重建后需重挂） */
export interface TradeMarksController {
  plugin: ISeriesMarkersPluginApi<Time> | null
  series: ISeriesApi<"Candlestick"> | ISeriesApi<"Line"> | null
}

export type TradeMarksControllerRef = {
  current: TradeMarksController | null
}

/** 附着或更新任务标记插件（序列变化时自动卸旧挂新） */
export function applyTradeMarks(
  series: ISeriesApi<"Candlestick"> | ISeriesApi<"Line"> | null,
  controllerRef: TradeMarksControllerRef,
  markers: SeriesMarker<Time>[],
): void {
  if (!series) {
    clearTradeMarks(controllerRef)
    return
  }
  const ctl = controllerRef.current
  if (ctl && ctl.series !== series) {
    // 序列已重建（周期/品种切换、蜡烛↔分时切换）：卸掉旧插件
    try {
      ctl.plugin?.detach()
    } catch {
      /* ignore */
    }
    controllerRef.current = null
  }
  if (!controllerRef.current) {
    try {
      controllerRef.current = {
        plugin: createSeriesMarkers(series, []),
        series,
      }
    } catch {
      controllerRef.current = null
      return
    }
  }
  try {
    controllerRef.current.plugin?.setMarkers(markers)
  } catch {
    // 时间不一致等：忽略单次
  }
}

/** 清空并卸载任务标记插件（任务切换/删除时调用） */
export function clearTradeMarks(controllerRef: TradeMarksControllerRef): void {
  const ctl = controllerRef.current
  if (!ctl) return
  try {
    ctl.plugin?.setMarkers([])
    ctl.plugin?.detach()
  } catch {
    /* ignore */
  }
  controllerRef.current = null
}
