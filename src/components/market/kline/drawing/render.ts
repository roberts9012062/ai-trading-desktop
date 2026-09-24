/**
 * K 线画图层渲染与命中检测（纯函数，无副作用，不依赖 DOM）
 *
 * 关键约束：本模块只「读取」lightweight-charts 的 IChartApi/ISeriesApi 来做坐标转换，
 * 绝不调用 setData/update/applyOptions 等，确保 K 线渲染与走势完全不受影响。
 */

import type { IChartApi, ISeriesApi, Logical, Time } from "lightweight-charts"
import type { DrawAnchor, DrawShape } from "./draw-types"

/** 像素坐标 */
export interface Pixel {
  x: number
  y: number
}

/** 命中检测的容差像素（线段周围多少 px 内算选中） */
const HIT_TOLERANCE_PX = 6
/** 端点小圆点半径 */
const ENDPOINT_RADIUS = 4
/** 端点命中半径 */
const ENDPOINT_HIT_RADIUS = 8

/**
 * 把数据锚点转成像素坐标
 * @returns null 表示端点当前不可见（滚出屏幕或 series 未就绪）
 */
function anchorToPixel(
  anchor: DrawAnchor,
  chart: IChartApi,
  series: ISeriesApi<"Candlestick">,
): Pixel | null {
  const x = chart.timeScale().timeToCoordinate(anchor.time)
  const y = series.priceToCoordinate(anchor.price)
  if (x === null || y === null) return null
  return { x, y }
}

/** 画布宽高（用于射线延长计算） */
export interface CanvasSize {
  width: number
  height: number
}

/**
 * 把两点（已知第一点，方向由两点确定）沿方向延长到画布边缘
 * 用于 ray（射线）工具
 */
function extendToEdge(p1: Pixel, p2: Pixel, size: CanvasSize): Pixel {
  const dx = p2.x - p1.x
  const dy = p2.y - p1.y
  // dx≈0 时垂直射线，直接延长到上/下边
  if (Math.abs(dx) < 0.5) {
    return { x: p1.x, y: dy >= 0 ? size.height : 0 }
  }
  // 计算到四条边的 t 参数，取落在画布内的最大值
  const candidates: number[] = []
  if (dx > 0) candidates.push((size.width - p1.x) / dx)
  else candidates.push(-p1.x / dx)
  if (dy > 0) candidates.push((size.height - p1.y) / dy)
  else if (dy < 0) candidates.push(-p1.y / dy)
  // 取最小的正 t（第一个相交的边）
  const t = Math.min(...candidates.filter((v) => Number.isFinite(v) && v > 0))
  const safeT = Number.isFinite(t) && t > 0 ? t : 0
  return { x: p1.x + dx * safeT, y: p1.y + dy * safeT }
}

/** 画一个箭头三角形（在 p2 处，方向 p1→p2） */
function drawArrowHead(ctx: CanvasRenderingContext2D, p1: Pixel, p2: Pixel, size: number): void {
  const angle = Math.atan2(p2.y - p1.y, p2.x - p1.x)
  const arrowLen = Math.max(10, size * 3)
  const arrowAngle = Math.PI / 6
  ctx.beginPath()
  ctx.moveTo(p2.x, p2.y)
  ctx.lineTo(
    p2.x - arrowLen * Math.cos(angle - arrowAngle),
    p2.y - arrowLen * Math.sin(angle - arrowAngle),
  )
  ctx.lineTo(
    p2.x - arrowLen * Math.cos(angle + arrowAngle),
    p2.y - arrowLen * Math.sin(angle + arrowAngle),
  )
  ctx.closePath()
  ctx.fill()
}

/** 绘制单个图形（假设端点像素坐标已计算） */
/** 在端点旁绘制价格标签（小圆角矩形 + 价格数字） */
function drawPriceLabel(
  ctx: CanvasRenderingContext2D,
  endpoint: Pixel,
  price: number,
  color: string,
  decimalPlaces: number,
  /** 标签放端点哪一侧：left=左侧，right=右侧 */
  side: "left" | "right",
  size: CanvasSize,
): void {
  const text = price.toFixed(decimalPlaces)
  ctx.save()
  ctx.font = "10px -apple-system, BlinkMacSystemFont, sans-serif"
  const padX = 4
  const padY = 2
  const textWidth = ctx.measureText(text).width
  const labelW = Math.ceil(textWidth) + padX * 2
  const labelH = 14
  // 标签位置：默认端点上方居中，按 side 偏左/右；贴边时翻到内侧
  let lx = side === "left" ? endpoint.x - labelW - 6 : endpoint.x + 6
  const ly = endpoint.y - labelH / 2
  if (lx < 2) lx = endpoint.x + 6
  if (lx + labelW > size.width - 2) lx = endpoint.x - labelW - 6
  // 背景
  ctx.fillStyle = "rgba(20, 20, 24, 0.85)"
  ctx.strokeStyle = color
  ctx.lineWidth = 1
  roundRect(ctx, lx, ly, labelW, labelH, 3)
  ctx.fill()
  ctx.stroke()
  // 文字
  ctx.fillStyle = "#e8e8ec"
  ctx.textBaseline = "middle"
  ctx.fillText(text, lx + padX, ly + labelH / 2 + 0.5)
  ctx.restore()
}

/** 圆角矩形路径（兼容老 canvas 无 roundRect） */
function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const radius = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + radius, y)
  ctx.lineTo(x + w - radius, y)
  ctx.arcTo(x + w, y, x + w, y + radius, radius)
  ctx.lineTo(x + w, y + h - radius)
  ctx.arcTo(x + w, y + h, x + w - radius, y + h, radius)
  ctx.lineTo(x + radius, y + h)
  ctx.arcTo(x, y + h, x, y + h - radius, radius)
  ctx.lineTo(x, y + radius)
  ctx.arcTo(x, y, x + radius, y, radius)
  ctx.closePath()
}

function strokeShape(
  ctx: CanvasRenderingContext2D,
  shape: DrawShape,
  p1: Pixel,
  p2: Pixel,
  size: CanvasSize,
  selected: boolean,
  decimalPlaces: number,
): void {
  ctx.save()
  ctx.strokeStyle = shape.color
  ctx.fillStyle = shape.color
  ctx.lineWidth = shape.width
  // 圆头让短斜线更顺滑
  ctx.lineCap = "round"
  ctx.lineJoin = "round"

  if (shape.tool === "ray") {
    const end = extendToEdge(p1, p2, size)
    ctx.beginPath()
    ctx.moveTo(p1.x, p1.y)
    ctx.lineTo(end.x, end.y)
    ctx.stroke()
  } else if (shape.tool === "arrow") {
    ctx.beginPath()
    ctx.moveTo(p1.x, p1.y)
    ctx.lineTo(p2.x, p2.y)
    ctx.stroke()
    drawArrowHead(ctx, p1, p2, shape.width)
  } else {
    // line：两点直线
    ctx.beginPath()
    ctx.moveTo(p1.x, p1.y)
    ctx.lineTo(p2.x, p2.y)
    ctx.stroke()
  }

  // 端点小圆点（除射线外，便于点击选中/感知端点位置）
  if (shape.tool !== "ray") {
    ctx.beginPath()
    ctx.arc(p1.x, p1.y, ENDPOINT_RADIUS, 0, Math.PI * 2)
    ctx.fill()
    ctx.beginPath()
    ctx.arc(p2.x, p2.y, ENDPOINT_RADIUS, 0, Math.PI * 2)
    ctx.fill()
  } else {
    // 射线只画起点圆点
    ctx.beginPath()
    ctx.arc(p1.x, p1.y, ENDPOINT_RADIUS, 0, Math.PI * 2)
    ctx.fill()
  }

  // 端点价格标签（所有线始终显示）：端点1 左侧、端点2 右侧；射线只有端点1
  drawPriceLabel(ctx, p1, shape.anchors[0].price, shape.color, decimalPlaces, "left", size)
  if (shape.tool !== "ray") {
    drawPriceLabel(ctx, p2, shape.anchors[1].price, shape.color, decimalPlaces, "right", size)
  }

  // 选中态：画虚线包围框提示
  if (selected) {
    ctx.strokeStyle = "#3b82f6"
    ctx.fillStyle = "#3b82f6"
    ctx.lineWidth = 1
    ctx.setLineDash([4, 3])
    const r = ENDPOINT_RADIUS + 3
    ctx.beginPath()
    ctx.arc(p1.x, p1.y, r, 0, Math.PI * 2)
    ctx.stroke()
    if (shape.tool !== "ray") {
      ctx.beginPath()
      ctx.arc(p2.x, p2.y, r, 0, Math.PI * 2)
      ctx.stroke()
    }
    ctx.setLineDash([])
  }
  ctx.restore()
}

export interface DrawAllOptions {
  /** 画布尺寸（用于射线延长与端点可见性判定） */
  size: CanvasSize
  /** 当前选中的图形 id */
  selectedId?: string | null
  /** 价格小数位（按品种 tick 推导：rb=0, au=2），用于端点价格标签 */
  decimalPlaces?: number
}

/**
 * 渲染所有图形
 *
 * @param ctx canvas 2d 上下文
 * @param chart LWC chart（仅用于坐标转换）
 * @param series 蜡烛 series（仅用于 price→y 转换）
 * @param shapes 要绘制的图形列表
 */
export function drawAllShapes(
  ctx: CanvasRenderingContext2D,
  chart: IChartApi,
  series: ISeriesApi<"Candlestick">,
  shapes: readonly DrawShape[],
  options: DrawAllOptions,
): void {
  ctx.clearRect(0, 0, options.size.width, options.size.height)
  for (const shape of shapes) {
    const p1 = anchorToPixel(shape.anchors[0], chart, series)
    const p2 = anchorToPixel(shape.anchors[1], chart, series)
    // 任一端点不可见（滚出屏幕）即跳过：
    // - 两端都不可见 → 显然无法画
    // - 只有一端可见 → 无法确定方向（射线/直线都需要两点定方向），跳过避免画错
    if (!p1 || !p2) continue
    strokeShape(ctx, shape, p1, p2, options.size, shape.id === options.selectedId, options.decimalPlaces ?? 0)
  }
}

/**
 * 渲染「正在绘制中」的预览线
 *
 * @param start 起点（已落点）
 * @param current 当前鼠标位置（像素）
 */
export function drawPreview(
  ctx: CanvasRenderingContext2D,
  chart: IChartApi,
  series: ISeriesApi<"Candlestick">,
  shape: DrawShape,
  start: DrawAnchor,
  currentPx: Pixel,
  size: CanvasSize,
): void {
  const p1 = anchorToPixel(start, chart, series)
  if (!p1) return
  ctx.save()
  ctx.strokeStyle = shape.color
  ctx.fillStyle = shape.color
  ctx.lineWidth = shape.width
  ctx.lineCap = "round"
  ctx.setLineDash([5, 4])
  ctx.beginPath()
  ctx.moveTo(p1.x, p1.y)
  if (shape.tool === "ray") {
    const end = extendToEdge(p1, currentPx, size)
    ctx.lineTo(end.x, end.y)
  } else {
    ctx.lineTo(currentPx.x, currentPx.y)
  }
  ctx.stroke()
  ctx.setLineDash([])
  // 起点圆点
  ctx.beginPath()
  ctx.arc(p1.x, p1.y, ENDPOINT_RADIUS, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()
}

/** 点到线段距离 */
function pointToSegmentDist(p: Pixel, a: Pixel, b: Pixel): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const lenSq = dx * dx + dy * dy
  if (lenSq === 0) return Math.hypot(p.x - a.x, p.y - a.y)
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
}

/**
 * 命中检测：返回点中的图形 id（优先端点，其次线段）
 */
export function hitTestShapes(
  shapes: readonly DrawShape[],
  point: Pixel,
  chart: IChartApi,
  series: ISeriesApi<"Candlestick">,
  size: CanvasSize,
): string | null {
  return hitTestHandle(shapes, point, chart, series, size)?.shapeId ?? null
}

/** 拖拽句柄命中：区分端点 0/1 与线身 body */
export type HandleHit = { shapeId: string; handle: 0 | 1 | "body" }

/**
 * 精确句柄命中检测（用于拖拽编辑）：
 * 优先级 端点0 → 端点1 → 线身 → null
 */
export function hitTestHandle(
  shapes: readonly DrawShape[],
  point: Pixel,
  chart: IChartApi,
  series: ISeriesApi<"Candlestick">,
  size: CanvasSize,
): HandleHit | null {
  // 倒序遍历：后画的在上层，优先命中
  for (let i = shapes.length - 1; i >= 0; i--) {
    const shape = shapes[i]
    const p1 = anchorToPixel(shape.anchors[0], chart, series)
    const p2 = anchorToPixel(shape.anchors[1], chart, series)
    if (!p1 || !p2) continue

    // 端点命中（射线没有第二端点拖拽）
    if (Math.hypot(point.x - p1.x, point.y - p1.y) <= ENDPOINT_HIT_RADIUS) {
      return { shapeId: shape.id, handle: 0 }
    }
    if (shape.tool !== "ray") {
      if (Math.hypot(point.x - p2.x, point.y - p2.y) <= ENDPOINT_HIT_RADIUS) {
        return { shapeId: shape.id, handle: 1 }
      }
    }

    // 线段命中
    let dist: number
    if (shape.tool === "ray") {
      const end = extendToEdge(p1, p2, size)
      dist = pointToSegmentDist(point, p1, end)
    } else {
      dist = pointToSegmentDist(point, p1, p2)
    }
    if (dist <= HIT_TOLERANCE_PX + shape.width / 2) {
      return { shapeId: shape.id, handle: "body" }
    }
  }
  return null
}

/**
 * 把像素坐标反推成数据锚点（time + price）
 *
 * 用于鼠标点击位置 → 数据坐标转换。优先用 coordinateToTime 反查；
 * 若落在无数据区域（右侧空白、两根 K 之间过远）返回 null 时，
 * 回退到 coordinateToLogical + 可见范围最近 bar 的时间，确保画线总能落点。
 */
export function pixelToAnchor(
  point: Pixel,
  chart: IChartApi,
  series: ISeriesApi<"Candlestick">,
  tickSize = 1,
): DrawAnchor | null {
  const ts = chart.timeScale()
  let time: Time | null = ts.coordinateToTime(point.x) as Time | null

  // coordinateToTime 在无数据区域（如右侧 rightOffset 空白）会返回 null。
  // 此时遍历可见范围附近的 bar logical，找到第一个能返回有效 time 的 bar，
  // 保证画线总能落点（吸附到最近的有效 K 线时间）。
  if (time === null) {
    const logical = ts.coordinateToLogical(point.x)
    if (logical !== null) {
      const targetLogical = Math.round(logical as number)
      // 从点击位置向数据起点方向搜索最近的有效 bar（最多 ±50 根）
      for (let offset = 0; offset <= 50; offset++) {
        for (const candidate of [targetLogical - offset, targetLogical + offset]) {
          if (candidate < 0) continue
          const coord = ts.logicalToCoordinate(candidate as unknown as Logical)
          if (coord === null) continue
          const tryTime = ts.coordinateToTime(coord) as Time | null
          if (tryTime !== null) {
            time = tryTime
            break
          }
        }
        if (time !== null) break
      }
    }
  }

  const rawPrice = series.coordinateToPrice(point.y)
  if (time === null || rawPrice === null) return null
  if (!Number.isFinite(rawPrice)) return null
  // 按品种 tick 吸附价格（rb→整数，cu→10 的倍数，au→0.02 的倍数）
  let price: number
  if (tickSize > 0 && tickSize !== 1) {
    price = Number((Math.round(rawPrice / tickSize) * tickSize).toFixed(10))
  } else {
    price = Math.round(rawPrice)
  }
  return { time, price }
}
