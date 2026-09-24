/**
 * K 线画图工具：类型与常量
 *
 * 图形以「数据坐标」(time + price) 存储，渲染时由 render.ts 转成像素坐标。
 * 这样 K 线缩放/平移、行情推进都不会让图形错位，且不影响 K 线本身的绘制。
 */

import type { Time } from "lightweight-charts"

/** 画图工具类型：cursor=光标(不画)，其余为可绘制线型 */
export type DrawTool = "cursor" | "line" | "ray" | "arrow"

/** 直线工具内部细分（仅 UI 区分，line=两点直线；ray=射线；arrow=箭头线） */
export type LineVariant = "line" | "ray" | "arrow"

/** 锚点：用 K 线数据坐标记录，与视口无关 */
export interface DrawAnchor {
  /** lightweight-charts 时间（日线为 'YYYY-MM-DD' 字符串，分钟线为 Unix 秒） */
  time: Time
  /** 价格 */
  price: number
}

/** 一个画好的图形 */
export interface DrawShape {
  id: string
  /** line=两点直线；ray=第二点后延长到屏幕边；arrow=第二点带箭头 */
  tool: Exclude<DrawTool, "cursor">
  color: string
  /** 线宽 px */
  width: number
  /** 两个端点 */
  anchors: [DrawAnchor, DrawAnchor]
  createdAt: number
}

/** 单合约+周期的画图集合 */
export interface DrawGroup {
  visible: boolean
  shapes: DrawShape[]
}

/** 预设色板（红/绿/蓝/紫/橙/青/白/黄） */
export const DRAW_COLORS: readonly string[] = [
  "#ef4444",
  "#22c55e",
  "#3b82f6",
  "#a855f7",
  "#f59e0b",
  "#06b6d4",
  "#e5e7eb",
  "#facc15",
] as const

/** 可选线宽 */
export const DRAW_WIDTHS: readonly number[] = [1, 2, 3, 4] as const

/** 默认颜色 */
export const DEFAULT_DRAW_COLOR = DRAW_COLORS[2]
/** 默认线宽 */
export const DEFAULT_DRAW_WIDTH = 2

/** localStorage 持久化 key */
export const DRAWING_STORAGE_KEY = "qihuo_drawings"

/** 工具栏按钮配置（label 用中文，符合项目 UI 习惯） */
export interface ToolOption {
  tool: DrawTool
  label: string
  title: string
}

export const TOOL_OPTIONS: readonly ToolOption[] = [
  { tool: "cursor", label: "光标", title: "光标（取消画图）" },
  { tool: "line", label: "直线", title: "直线（两点）" },
  { tool: "ray", label: "斜线", title: "斜线 / 射线（延长到边缘）" },
  { tool: "arrow", label: "箭头", title: "箭头线" },
] as const

/** 生成图形 id（时间戳 + 随机） */
export function makeShapeId(): string {
  return `d_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}
