"use client";

/**
 * AI 主播K线图解标注 —— 价位虚线 + 买卖区域色带 + 测试数据合成
 *
 * 从播报结论生成画线标注;「AI画线测试」用真实K线合成示例结论
 * (止盈止损/买卖区域/压力支撑),不调模型、不依赖真实播报。
 */

import { LineSeries, LineStyle, type IChartApi, type ISeriesApi, type Time } from "lightweight-charts"
import type { AnchorBroadcast, AnchorKeyLevel } from "@/lib/ai-anchor-api"
import type { KlineBar } from "@/types"

/** 价格区间色带(买卖区域/箱体区间) */
export interface AnchorZone {
  upper: number
  lower: number
  label: string
  /** 半透明填充色 rgba */
  color: string
  /** 边线色 */
  borderColor: string
}

/** 未来走势投影点(offset=未来第几根K线) */
export interface AnchorProjectionPoint {
  offset: number
  price: number
}

/** 未来走势预测路径(从当前收盘价延伸的虚线) */
export interface AnchorProjection {
  label: string
  points: AnchorProjectionPoint[]
}

/** 一套完整画线标注 */
export interface AnchorAnnotations {
  direction: "long" | "short" | "neutral"
  entry: number | null
  take_profit: number | null
  stop_loss: number | null
  key_levels: AnchorKeyLevel[]
  zones: AnchorZone[]
  projection?: AnchorProjection | null
}

/** 真实播报 → 标注(无区域色带;区域仅测试演示) */
export function broadcastToAnnotations(broadcast: AnchorBroadcast): AnchorAnnotations {
  return {
    direction: broadcast.direction,
    entry: broadcast.entry,
    take_profit: broadcast.take_profit,
    stop_loss: broadcast.stop_loss,
    key_levels: broadcast.key_levels ?? [],
    zones: [],
  }
}

/** 在蜡烛序列上画价位虚线(title 即线旁价格标签) */
export function addAnnotationLines(
  series: ISeriesApi<"Candlestick">,
  annotations: AnchorAnnotations,
): void {
  const dashed = (price: number, color: string, title: string): void => {
    series.createPriceLine({
      price,
      color,
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      axisLabelVisible: true,
      title,
    })
  }
  if (annotations.entry != null)
    dashed(annotations.entry, "#f59e0b", `进场 ${annotations.entry}`)
  if (annotations.take_profit != null)
    dashed(annotations.take_profit, "#22c55e", `止盈 ${annotations.take_profit}`)
  if (annotations.stop_loss != null)
    dashed(annotations.stop_loss, "#ef4444", `止损 ${annotations.stop_loss}`)
  for (const level of annotations.key_levels) {
    const color = level.type === "resistance" ? "#fb923c" : "#60a5fa"
    const name = level.type === "resistance" ? "压力" : "支撑"
    const label = level.label ? `${name}·${level.label}` : name
    dashed(level.price, color, `${label} ${level.price}`)
  }
}

/**
 * 把区域色带画到叠加画布上(半透明矩形 + 虚线边 + 右侧标签)。
 * 画布与图表同尺寸绝对定位、不拦截鼠标;价格超出可视区跳过该带。
 */
export function drawZoneOverlay(
  canvas: HTMLCanvasElement,
  series: ISeriesApi<"Candlestick">,
  zones: AnchorZone[],
): void {
  const ctx = canvas.getContext("2d")
  if (!ctx) return
  const dpr = window.devicePixelRatio || 1
  const width = canvas.clientWidth
  const height = canvas.clientHeight
  if (width === 0 || height === 0) return
  if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
    canvas.width = Math.round(width * dpr)
    canvas.height = Math.round(height * dpr)
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, width, height)
  ctx.font = "10px sans-serif"
  ctx.textAlign = "right"

  for (const zone of zones) {
    const y1 = series.priceToCoordinate(zone.upper)
    const y2 = series.priceToCoordinate(zone.lower)
    if (y1 == null || y2 == null) continue
    const top = Math.min(y1, y2)
    const bottom = Math.max(y1, y2)
    // 半透明底纹
    ctx.fillStyle = zone.color
    ctx.fillRect(0, top, width, bottom - top)
    // 上下虚线边
    ctx.strokeStyle = zone.borderColor
    ctx.setLineDash([4, 3])
    ctx.lineWidth = 1
    for (const y of [top, bottom]) {
      ctx.beginPath()
      ctx.moveTo(0, y)
      ctx.lineTo(width, y)
      ctx.stroke()
    }
    ctx.setLineDash([])
    // 右侧标签(带上沿上方)
    ctx.fillStyle = zone.borderColor
    ctx.fillText(`${zone.label} ${zone.lower} ~ ${zone.upper}`, width - 6, top - 3)
  }
}

/** 标注涉及的全部价位(含区域边界/投影点位) */
function annotationPrices(annotations: AnchorAnnotations): number[] {
  const prices: number[] = []
  if (annotations.entry != null) prices.push(annotations.entry)
  if (annotations.take_profit != null) prices.push(annotations.take_profit)
  if (annotations.stop_loss != null) prices.push(annotations.stop_loss)
  for (const level of annotations.key_levels) prices.push(level.price)
  for (const zone of annotations.zones) {
    prices.push(zone.upper)
    prices.push(zone.lower)
  }
  if (annotations.projection) {
    for (const point of annotations.projection.points) prices.push(point.price)
  }
  return prices
}

/**
 * 未来走势投影序列:从最后一根K线的当前价画紫色点虚线延伸到未来时间点。
 * 分钟周期 time 为 UTCTimestamp(秒),按 offset×周期间隔外推;
 * 日线 time 为 'YYYY-MM-DD' 字符串(或 BusinessDay),按 offset 天外推——
 * 直接对字符串做算术会得到 NaN,必须走日期换算。
 */
export function addProjectionSeries(
  chart: IChartApi,
  chartTimes: Time[],
  projection: AnchorProjection,
  startPrice: number,
): ISeriesApi<"Line"> | null {
  if (chartTimes.length < 2 || projection.points.length === 0) return null
  const lastRaw = chartTimes[chartTimes.length - 1]
  const sorted = [...projection.points].sort((a, b) => a.offset - b.offset)
  const points = sorted.filter(
    (p) => Number.isFinite(p.offset) && Math.round(p.offset) > 0 && Number.isFinite(p.price),
  )
  if (points.length === 0) return null

  const data: Array<{ time: Time; value: number }> = [
    { time: lastRaw, value: startPrice },
  ]
  if (typeof lastRaw === "number") {
    const step = Math.max(1, lastRaw - (chartTimes[chartTimes.length - 2] as number))
    for (const point of points) {
      data.push({
        time: (lastRaw + Math.round(point.offset) * step) as Time,
        value: point.price,
      })
    }
  } else {
    // 日线字符串/日期对象:统一转 Date 按天外推
    const toDate = (value: Time): number => {
      if (typeof value === "string") {
        return Date.parse(
          value.length <= 10 ? `${value}T00:00:00Z` : value.replace(" ", "T") + "Z",
        )
      }
      const day = value as { year: number; month: number; day: number }
      return Date.UTC(day.year, day.month - 1, day.day)
    }
    const lastMs = toDate(lastRaw)
    for (const point of points) {
      const next = new Date(lastMs + Math.round(point.offset) * 86400000)
      data.push({
        time: next.toISOString().slice(0, 10) as Time,
        value: point.price,
      })
    }
  }
  if (data.length < 2) return null

  const series = chart.addSeries(LineSeries, {
    color: "#a78bfa",
    lineWidth: 2,
    lineStyle: LineStyle.Dotted,
    priceLineVisible: false,
    lastValueVisible: true,
    title: projection.label || "预期走势",
  })
  series.setData(data)
  return series
}

/**
 * 透明边界序列:lightweight-charts 的自动缩放只依据序列数据,
 * 不计入 priceLine——标注价位超出蜡烛范围时虚线会被裁在可视区外。
 * 用一条透明线把首尾两根K线撑到 [蜡烛∪标注] 的联合范围,
 * 使 进场/止盈/止损/压支位/区域 全部可见。
 */
export function applyPriceBounds(
  chart: IChartApi,
  bars: KlineBar[],
  chartTimes: Time[],
  annotations: AnchorAnnotations,
): ISeriesApi<"Line"> | null {
  const prices = annotationPrices(annotations)
  if (prices.length === 0 || bars.length === 0 || chartTimes.length === 0) return null
  const candleLow = Math.min(...bars.map((bar) => bar.low))
  const candleHigh = Math.max(...bars.map((bar) => bar.high))
  const low = Math.min(candleLow, ...prices)
  const high = Math.max(candleHigh, ...prices)
  if (!(high > low)) return null
  const bounds = chart.addSeries(LineSeries, {
    color: "rgba(0,0,0,0)",
    lineWidth: 1,
    priceLineVisible: false,
    lastValueVisible: false,
    crosshairMarkerVisible: false,
  })
  bounds.setData([
    { time: chartTimes[0], value: low },
    { time: chartTimes[chartTimes.length - 1], value: high },
  ])
  return bounds
}

/**
 * 用真实K线合成一套"AI 画线测试"示例结论(做多结构):
 * 买入区=现价回踩带,止盈区=目标带上沿下沿,止损/止盈线,近端高/低点为压力/支撑。
 */
export function buildTestAnnotations(bars: KlineBar[]): AnchorAnnotations {
  if (bars.length === 0) {
    return {
      direction: "neutral",
      entry: null,
      take_profit: null,
      stop_loss: null,
      key_levels: [],
      zones: [],
    }
  }
  const last = bars[bars.length - 1]
  const recent = bars.slice(-20)
  const avgRange =
    recent.reduce((sum, bar) => sum + (bar.high - bar.low), 0) / Math.max(1, recent.length)
  const rng = avgRange > 0 ? avgRange : last.close * 0.004
  const round = (value: number): number => Math.round(value * 10) / 10

  const buyLower = round(last.close - rng * 0.6)
  const buyUpper = round(last.close + rng * 0.2)
  const entry = round((buyLower + buyUpper) / 2)
  const takeProfit = round(last.close + rng * 3)
  const stopLoss = round(last.close - rng * 1.5)
  const window = bars.slice(-40)
  const resistance = round(Math.max(...window.map((bar) => bar.high)))
  const support = round(Math.min(...window.map((bar) => bar.low)))

  return {
    direction: "long",
    entry,
    take_profit: takeProfit,
    stop_loss: stopLoss,
    key_levels: [
      { price: resistance, type: "resistance", label: "近端高点" },
      { price: support, type: "support", label: "近端低点" },
    ],
    zones: [
      {
        upper: buyUpper,
        lower: buyLower,
        label: "买入区",
        color: "rgba(245,158,11,0.12)",
        borderColor: "#f59e0bcc",
      },
      {
        upper: round(takeProfit + rng * 0.8),
        lower: round(takeProfit - rng * 0.8),
        label: "止盈区",
        color: "rgba(34,197,94,0.10)",
        borderColor: "#22c55ecc",
      },
    ],
  }
}
