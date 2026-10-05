"use client";

/**
 * AI 对话画图指令 —— 模型在回复中输出 ```chart JSON 块，前端解析成标注渲染
 *
 * 指令格式（字段容错，非法项跳过）：
 * {
 *   "symbol": "rb2610", "period": "15m", "limit": 120,
 *   "levels": [{"price": 2580, "role": "resistance", "label": "前高压力"}],
 *   "zones":  [{"upper": 2570, "lower": 2540, "label": "箱体区间"}],
 *   "projection": {"label": "预期路径", "points": [{"offset": 4, "price": 2560}]}
 * }
 * role: entry 进场(琥珀) / take_profit 止盈(绿) / stop_loss 止损(红) /
 *       resistance 压力(橙) / support 支撑(蓝)
 */

import type { AnchorAnnotations, AnchorProjection, AnchorZone } from "./anchor-chart-annotations"
import type { AnchorKeyLevel } from "@/lib/ai-anchor-api"

/** 一条画图指令 */
export interface ChartDirective {
  symbol: string
  period: string
  limit: number
  annotations: AnchorAnnotations
  /** 指令标题（模型可给，如"甲醇15分钟压力支撑图"） */
  title: string
}

const SUPPORTED_PERIODS = new Set(["1m", "5m", "15m", "30m", "60m", "240m", "1d"])
/** 模型常见的周期写法归一 */
const PERIOD_ALIASES: Record<string, string> = {
  "1": "1m", min1: "1m", m1: "1m",
  "5": "5m", min5: "5m", m5: "5m",
  "15": "15m", min15: "15m", m15: "15m", "15min": "15m",
  "30": "30m", min30: "30m", m30: "30m", "30min": "30m",
  "60": "60m", min60: "60m", m60: "60m", "60min": "60m", "1h": "60m", h1: "60m",
  "240": "240m", min240: "240m", m240: "240m", "240min": "240m", "4h": "240m", h4: "240m", "4小时": "240m",
  "1d": "1d", d1: "1d", day: "1d", daily: "1d",
}
/** 模型常见的 role 写法归一 */
const ROLE_ALIASES: Record<string, string> = {
  entry: "entry", 进场: "entry", 买入: "entry", 买点: "entry", buy: "entry",
  take_profit: "take_profit", takeprofit: "take_profit", "take-profit": "take_profit",
  tp: "take_profit", 止盈: "take_profit", target: "take_profit",
  stop_loss: "stop_loss", stoploss: "stop_loss", "stop-loss": "stop_loss",
  sl: "stop_loss", 止损: "stop_loss",
  resistance: "resistance", res: "resistance", 压力: "resistance", 压力位: "resistance",
  support: "support", sup: "support", 支撑: "support", 支撑位: "support",
}

function normalizeRole(raw: unknown): string {
  return ROLE_ALIASES[String(raw ?? "").toLowerCase().trim()] ?? ""
}

function normalizePeriod(raw: unknown): string | null {
  const key = String(raw ?? "").toLowerCase().trim()
  if (SUPPORTED_PERIODS.has(key)) return key
  return PERIOD_ALIASES[key] ?? null
}

/** 箱体/区域默认配色（蓝系，与买卖测试区色带区分） */
const ZONE_DEFAULT_COLOR = "rgba(96,165,250,0.12)"
const ZONE_DEFAULT_BORDER = "#60a5facc"

function toPrice(value: unknown): number | null {
  const num = typeof value === "number" ? value : Number(value)
  return Number.isFinite(num) && num > 0 ? Math.round(num * 10000) / 10000 : null
}

function parseLevels(raw: unknown): {
  entry: number | null
  takeProfit: number | null
  stopLoss: number | null
  keyLevels: AnchorKeyLevel[]
} {
  const out = { entry: null as number | null, takeProfit: null as number | null, stopLoss: null as number | null, keyLevels: [] as AnchorKeyLevel[] }
  if (!Array.isArray(raw)) return out
  for (const item of raw.slice(0, 12)) {
    if (typeof item !== "object" || item === null) continue
    const record = item as Record<string, unknown>
    const price = toPrice(record.price)
    if (price == null) continue
    // 兼容两种形状：扁平 {price, role} 与嵌套 {price: {value}, type}
    const roleRaw = record.role ?? record.type ?? record.name ?? record.level_type
    const role = normalizeRole(roleRaw)
    const label = String(record.label ?? record.note ?? "").slice(0, 40)
    if (role === "entry" && out.entry == null) out.entry = price
    else if (role === "take_profit" && out.takeProfit == null) out.takeProfit = price
    else if (role === "stop_loss" && out.stopLoss == null) out.stopLoss = price
    else if (role === "resistance" || role === "support") {
      out.keyLevels.push({ price, type: role, label })
    }
  }
  return out
}

function parseZones(raw: unknown): AnchorZone[] {
  if (!Array.isArray(raw)) return []
  const zones: AnchorZone[] = []
  for (const item of raw.slice(0, 6)) {
    if (typeof item !== "object" || item === null) continue
    const record = item as Record<string, unknown>
    // upper/lower 别名：high/low、top/bottom、max/min
    const upper = toPrice(record.upper ?? record.high ?? record.top ?? record.max)
    const lower = toPrice(record.lower ?? record.low ?? record.bottom ?? record.min)
    if (upper == null || lower == null || upper <= lower) continue
    zones.push({
      upper,
      lower,
      label: String(record.label ?? record.name ?? "区间").slice(0, 30) || "区间",
      color: typeof record.color === "string" && record.color ? record.color : ZONE_DEFAULT_COLOR,
      borderColor:
        typeof record.borderColor === "string" && record.borderColor
          ? record.borderColor
          : ZONE_DEFAULT_BORDER,
    })
  }
  return zones
}

function parseProjection(raw: unknown): AnchorProjection | null {
  if (typeof raw !== "object" || raw === null) return null
  const record = raw as Record<string, unknown>
  const pointsRaw = Array.isArray(record.points)
    ? record.points
    : Array.isArray(record.path)
      ? record.path
      : []
  const points = [] as Array<{ offset: number; price: number }>
  for (const item of pointsRaw.slice(0, 12)) {
    if (typeof item !== "object" || item === null) continue
    const point = item as Record<string, unknown>
    const offsetRaw = point.offset ?? point.bars ?? point.step ?? point.k
    const offset = Number(offsetRaw)
    const price = toPrice(point.price ?? point.value ?? point.target)
    if (!Number.isFinite(offset) || offset <= 0 || price == null) continue
    points.push({ offset: Math.round(offset), price })
  }
  if (points.length === 0) return null
  return {
    label: String(record.label ?? record.name ?? "预期走势").slice(0, 20) || "预期走势",
    points,
  }
}

/** 解析单个 chart JSON 文本为指令；无效返回 null。
 * fallbackSymbol：模型漏写 symbol 时用对话上下文里的当前合约兜底。 */
export function parseChartDirective(
  jsonText: string,
  fallbackSymbol?: string,
  fallbackPeriod?: string,
): ChartDirective | null {
  let data: Record<string, unknown>
  try {
    const parsed = JSON.parse(jsonText) as unknown
    if (typeof parsed !== "object" || parsed === null) return null
    data = parsed as Record<string, unknown>
  } catch {
    return null
  }
  const symbol = String(data.symbol ?? data.contract ?? "").trim().toLowerCase() ||
    (fallbackSymbol ?? "").trim().toLowerCase()
  if (!symbol) return null
  const period =
    normalizePeriod(data.period ?? data.timeframe ?? data.interval) ??
    normalizePeriod(fallbackPeriod) ??
    "15m"
  const limitRaw = Number(data.limit)
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(30, Math.round(limitRaw)), 300) : 120
  const levels = parseLevels(data.levels ?? data.key_levels ?? data.lines)
  const zones = parseZones(data.zones ?? data.boxes ?? data.ranges)
  const projection = parseProjection(data.projection ?? data.forecast ?? data.trend)
  const annotations: AnchorAnnotations = {
    direction: "neutral",
    entry: levels.entry,
    take_profit: levels.takeProfit,
    stop_loss: levels.stopLoss,
    key_levels: levels.keyLevels.slice(0, 8),
    zones,
    projection,
  }
  // 至少要有一个有效标注元素才算合法指令
  const hasAny =
    annotations.entry != null ||
    annotations.take_profit != null ||
    annotations.stop_loss != null ||
    annotations.key_levels.length > 0 ||
    zones.length > 0 ||
    projection != null
  if (!hasAny) return null
  return {
    symbol,
    period,
    limit,
    annotations,
    title: String(data.title ?? data.name ?? "").slice(0, 40),
  }
}

/** 消息文本分段：普通文字与 chart 指令交替 */
export interface MessageSegment {
  kind: "text" | "chart"
  /** text=文字内容；chart=指令 */
  content: string
  /** chart 段解析结果（解析失败时 directive 为 null，按文字展示原文） */
  directive: ChartDirective | null
}

const CHART_BLOCK = /```(?:chart|json)?[ \t]*\n?([\s\S]*?)```/g

/** 判断 JSON 文本是否带画图指令特征（决定 ```json/``` 围栏是否转图）。
 *  symbol 可由 fallbackSymbol 兜底，故只看画图字段。 */
function looksLikeChartJson(jsonText: string): boolean {
  return /"(?:levels|key_levels|lines|zones|boxes|ranges|projection|forecast|trend)"\s*:/.test(
    jsonText,
  )
}

/** 把 AI 回复拆成 [文字 | chart指令] 交替段。
 * 识别 ```chart 围栏；```json/``` 围栏内容带画图特征时也转图；
 * 解析失败的块按原文展示。fallbackSymbol 用于模型漏写 symbol 时兜底。 */
export function splitChartSegments(
  text: string,
  fallbackSymbol?: string,
  fallbackPeriod?: string,
): MessageSegment[] {
  const segments: MessageSegment[] = []
  let cursor = 0
  for (const match of text.matchAll(CHART_BLOCK)) {
    const index = match.index ?? 0
    const fence = (match[0].match(/^```(\w*)/) ?? [])[1] ?? ""
    const body = match[1] ?? ""
    // 非 chart 围栏的块必须带画图特征才尝试转图，避免误吞普通代码/JSON 说明
    const shouldTry = fence === "chart" || (looksLikeChartJson(body.trim()))
    if (!shouldTry) continue
    if (index > cursor) {
      segments.push({ kind: "text", content: text.slice(cursor, index), directive: null })
    }
    const jsonText = body.trim()
    segments.push({
      kind: "chart",
      content: jsonText,
      directive: parseChartDirective(jsonText, fallbackSymbol, fallbackPeriod),
    })
    cursor = index + match[0].length
  }
  if (cursor < text.length) {
    segments.push({ kind: "text", content: text.slice(cursor), directive: null })
  }
  return segments
}

/** 回复中是否已含可渲染的 chart 指令（自动补图判断用） */
export function hasRenderableChart(
  text: string,
  fallbackSymbol?: string,
  fallbackPeriod?: string,
): boolean {
  return splitChartSegments(text, fallbackSymbol, fallbackPeriod).some(
    (segment) => segment.kind === "chart" && segment.directive != null,
  )
}
