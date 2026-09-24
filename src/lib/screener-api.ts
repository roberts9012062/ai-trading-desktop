/**
 * 行情筛选 API —— 全市场主力 · 多指标条件组合筛选
 *
 * 后端 POST /api/market/screener：所有条件 AND 组合，
 * window 表示「最近 N 根已收盘K内出现」。
 */

export type ScreenerCondType =
  | "pivot"
  | "macd"
  | "ma"
  | "kdj"
  | "rsi"
  | "boll"

export type ScreenerPeriod = "5m" | "15m" | "30m" | "60m" | "1d"

/** 用户图表指标设置中筛选会用到的字段（来自 /api/indicators/settings） */
export interface ChartIndicatorConfig {
  maLines?: Array<{ period: number }>
  macd?: { fastPeriod?: number; slowPeriod?: number; signalPeriod?: number }
  rsi?: { period?: number; overbought?: number; oversold?: number }
  boll?: { period?: number; std?: number }
  jdk?: { rsvPeriod?: number; kPeriod?: number; dPeriod?: number }
  pivot?: {
    left?: number
    right?: number
    atrPeriod?: number
    minAmplitudePct?: number
    minAtrMult?: number
  }
}

export interface ScreenerCondition {
  /** 前端 react key，提交时剔除 */
  id: string
  type: ScreenerCondType
  op: string
  side: "long" | "short" | "any"
  window: number
  // pivot：分型左右根数 / ATR 周期 / 幅度过滤（对齐图表波段指标）
  left: number
  right: number
  atr_period: number
  min_amplitude_pct: number
  min_atr_mult: number
  // macd
  fast: number
  slow: number
  signal: number
  // ma
  ma_short: number
  ma_mid: number
  ma_long: number
  cross_period: number
  // kdj
  n: number
  k_smooth: number
  d_smooth: number
  // kdj / rsi 阈值（null = 后端按类型默认：KDJ 80/20，RSI 70/30）
  overbought: number | null
  oversold: number | null
  // rsi / boll
  period: number
  std: number
}

export interface ScreenerCondResult {
  type: string
  label: string
  passed: boolean
  detail: string
}

export interface ScreenerItem {
  symbol: string
  product_code: string
  name: string
  product_name: string
  contract_name: string
  period: string
  as_of: string
  last_price: number | null
  direction: "long" | "short" | "mixed" | "neutral" | string
  conditions: ScreenerCondResult[]
}

export interface ScreenerResponse {
  period: string
  period_label: string
  trading_mode: string
  scanned: number
  total: number
  items: ScreenerItem[]
  elapsed_ms: number
  message: string
  meta?: Record<string, unknown>
}

export const SCREENER_PERIODS: Array<{
  value: ScreenerPeriod
  label: string
}> = [
  { value: "5m", label: "5分钟" },
  { value: "15m", label: "15分钟" },
  { value: "30m", label: "30分钟" },
  { value: "60m", label: "60分钟" },
  { value: "1d", label: "日线" },
]

/** 各指标类型的中文名与可选操作 */
export const COND_TYPE_META: Record<
  ScreenerCondType,
  { name: string; ops: Array<{ value: string; label: string }> }
> = {
  pivot: {
    name: "波段多空",
    ops: [
      { value: "long", label: "做多信号（波谷）" },
      { value: "short", label: "做空信号（波峰）" },
      { value: "any", label: "多空任一" },
    ],
  },
  macd: {
    name: "MACD",
    ops: [
      { value: "golden", label: "金叉" },
      { value: "death", label: "死叉" },
      { value: "dif_above", label: "DIF在DEA上方" },
      { value: "dif_below", label: "DIF在DEA下方" },
    ],
  },
  ma: {
    name: "均线",
    ops: [
      { value: "bull_arrange", label: "多头排列" },
      { value: "bear_arrange", label: "空头排列" },
      { value: "cross_above", label: "上穿均线" },
      { value: "cross_below", label: "下穿均线" },
    ],
  },
  kdj: {
    name: "KDJ",
    ops: [
      { value: "golden", label: "金叉" },
      { value: "death", label: "死叉" },
      { value: "overbought", label: "超买" },
      { value: "oversold", label: "超卖" },
    ],
  },
  rsi: {
    name: "RSI",
    ops: [
      { value: "overbought", label: "超买" },
      { value: "oversold", label: "超卖" },
      { value: "cross_up_50", label: "上穿50" },
      { value: "cross_down_50", label: "下穿50" },
    ],
  },
  boll: {
    name: "布林带",
    ops: [
      { value: "break_upper", label: "突破上轨" },
      { value: "break_lower", label: "跌破下轨" },
      { value: "above_middle", label: "中轨上方" },
      { value: "below_middle", label: "中轨下方" },
    ],
  },
}

/** window 仅对「事件类」op 生效；状态类 op 忽略 */
const STATE_OPS = new Set([
  "dif_above",
  "dif_below",
  "bull_arrange",
  "bear_arrange",
  "overbought",
  "oversold",
  "above_middle",
  "below_middle",
])

export function opUsesWindow(cond: Pick<ScreenerCondition, "type" | "op">): boolean {
  if (cond.type === "pivot") return true
  return !STATE_OPS.has(cond.op)
}

/** 新建条件的默认参数（对齐图表指标默认值） */
export function makeCondition(type: ScreenerCondType): ScreenerCondition {
  const base: ScreenerCondition = {
    id: `${type}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    type,
    op: "golden",
    side: "any",
    window: 1,
    left: 3,
    right: 3,
    atr_period: 14,
    min_amplitude_pct: 1.5,
    min_atr_mult: 1.5,
    fast: 12,
    slow: 26,
    signal: 9,
    ma_short: 5,
    ma_mid: 10,
    ma_long: 20,
    cross_period: 20,
    n: 9,
    k_smooth: 3,
    d_smooth: 3,
    overbought: null,
    oversold: null,
    period: 14,
    std: 2,
  }
  switch (type) {
    case "pivot":
      return { ...base, side: "long" }
    case "macd":
      return { ...base, op: "golden" }
    case "ma":
      return { ...base, op: "bull_arrange" }
    case "kdj":
      return { ...base, op: "golden", overbought: 80, oversold: 20 }
    case "rsi":
      return { ...base, op: "overbought", overbought: 70, oversold: 30 }
    case "boll":
      return { ...base, op: "break_upper", period: 20 }
  }
}

/**
 * 用用户保存的图表指标设置覆盖新建条件默认参数，
 * 保证「筛选参数 = 图表参数」，筛选结果才能与K线图上的标注对应。
 */
export function applyChartDefaults(
  cond: ScreenerCondition,
  cfg: ChartIndicatorConfig | null,
): ScreenerCondition {
  if (!cfg) return cond
  const next = { ...cond }
  switch (cond.type) {
    case "pivot":
      if (cfg.pivot) {
        next.left = cfg.pivot.left ?? next.left
        next.right = cfg.pivot.right ?? next.right
        next.atr_period = cfg.pivot.atrPeriod ?? next.atr_period
        next.min_amplitude_pct = cfg.pivot.minAmplitudePct ?? next.min_amplitude_pct
        next.min_atr_mult = cfg.pivot.minAtrMult ?? next.min_atr_mult
      }
      break
    case "macd":
      if (cfg.macd) {
        next.fast = cfg.macd.fastPeriod ?? next.fast
        next.slow = cfg.macd.slowPeriod ?? next.slow
        next.signal = cfg.macd.signalPeriod ?? next.signal
      }
      break
    case "ma":
      if (Array.isArray(cfg.maLines) && cfg.maLines.length > 0) {
        next.ma_short = cfg.maLines[0]?.period ?? next.ma_short
        next.ma_mid = cfg.maLines[1]?.period ?? next.ma_mid
        next.ma_long = cfg.maLines[2]?.period ?? next.ma_long
        next.cross_period = cfg.maLines[cfg.maLines.length - 1]?.period ?? next.cross_period
      }
      break
    case "kdj":
      if (cfg.jdk) {
        next.n = cfg.jdk.rsvPeriod ?? next.n
        next.k_smooth = cfg.jdk.kPeriod ?? next.k_smooth
        next.d_smooth = cfg.jdk.dPeriod ?? next.d_smooth
      }
      break
    case "rsi":
      if (cfg.rsi) {
        next.period = cfg.rsi.period ?? next.period
        next.overbought = cfg.rsi.overbought ?? next.overbought
        next.oversold = cfg.rsi.oversold ?? next.oversold
      }
      break
    case "boll":
      if (cfg.boll) {
        next.period = cfg.boll.period ?? next.period
        next.std = cfg.boll.std ?? next.std
      }
      break
  }
  return next
}

/** 条件的简短描述（条件卡片标题右侧预览） */
export function conditionSummary(cond: ScreenerCondition): string {
  const meta = COND_TYPE_META[cond.type]
  if (cond.type === "pivot") {
    const side = meta.ops.find((o) => o.value === cond.side)?.label ?? "多空任一"
    return `波段 · ${side}`
  }
  const op = meta.ops.find((o) => o.value === cond.op)?.label ?? cond.op
  let param = ""
  if (cond.type === "macd") param = `(${cond.fast},${cond.slow},${cond.signal})`
  else if (cond.type === "ma")
    param =
      cond.op === "bull_arrange" || cond.op === "bear_arrange"
        ? `(MA${cond.ma_short}/${cond.ma_mid}/${cond.ma_long})`
        : `(MA${cond.cross_period})`
  else if (cond.type === "kdj") param = `(${cond.n},${cond.k_smooth},${cond.d_smooth})`
  else if (cond.type === "rsi") param = `(${cond.period})`
  else if (cond.type === "boll") param = `(${cond.period},${cond.std})`
  return `${meta.name} · ${op}${param}`
}

/**
 * 归一化恢复的条件：合并到该类型默认值上，
 * 兼容旧版本持久化数据缺少新增字段（如 left/right/atr_period）的情况
 */
export function normalizeCondition(
  raw: Partial<ScreenerCondition>,
): ScreenerCondition {
  if (!raw?.type || !(raw.type in COND_TYPE_META)) return makeCondition("pivot")
  const base = makeCondition(raw.type)
  return { ...base, ...raw, id: raw.id ?? base.id }
}

const API_BASE = (process.env.NEXT_PUBLIC_API_URL ?? "").replace(/\/$/, "")

/** 提交体：剔除前端 id 等多余字段 */
function toPayloadCond(cond: ScreenerCondition): Record<string, unknown> {
  const { id: _id, ...rest } = cond
  return rest
}

export async function runScreenerApi(
  period: ScreenerPeriod,
  conditions: ScreenerCondition[],
): Promise<ScreenerResponse> {
  const token =
    typeof window !== "undefined" ? localStorage.getItem("access_token") : null
  const res = await fetch(`${API_BASE}/api/market/screener`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    cache: "no-store",
    body: JSON.stringify({
      period,
      conditions: conditions.map(toPayloadCond),
    }),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`HTTP ${res.status}${text ? ` · ${text.slice(0, 120)}` : ""}`)
  }
  return (await res.json()) as ScreenerResponse
}
