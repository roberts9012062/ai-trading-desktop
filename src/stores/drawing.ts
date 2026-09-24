"use client"

/**
 * K 线画图工具 store
 *
 * - 图形按「合约 + 周期」分组存储，切合约/切周期互不影响。
 * - localStorage 持久化（debounce 200ms），刷新页面后恢复。
 * - 整体「显隐开关」切换时仅控制可见性，不删除数据。
 *
 * 完全不引用 lightweight-charts，纯数据层，可在 SSR 安全加载。
 */

import { create } from "zustand"
import {
  DEFAULT_DRAW_COLOR,
  DEFAULT_DRAW_WIDTH,
  DRAWING_STORAGE_KEY,
  makeShapeId,
  type DrawGroup,
  type DrawShape,
  type DrawTool,
} from "@/components/market/kline/drawing/draw-types"
import type { KlinePeriod } from "@/types"

/** 持久化结构：symbol -> period -> group */
type DrawingMap = Record<string, Record<string, DrawGroup>>

/** 持久化防抖句柄（模块级，跨 set 共享） */
let saveTimer: ReturnType<typeof setTimeout> | null = null
const SAVE_DEBOUNCE_MS = 200

/** group 不存在时的稳定默认引用（避免 selector 每次返回新对象导致重渲染） */
const EMPTY_GROUP: DrawGroup = { visible: true, shapes: [] }

/** 序列化字段前缀，便于后续 key 变更时的迁移识别 */
const STORAGE_VERSION = 1

interface PersistPayload {
  v: number
  data: DrawingMap
}

/** 读取 localStorage */
function loadMap(): DrawingMap {
  if (typeof window === "undefined") return {}
  try {
    const raw = localStorage.getItem(DRAWING_STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as PersistPayload | DrawingMap
    // 兼容老版本（无 v 字段）
    if (parsed && typeof parsed === "object" && "v" in parsed && "data" in parsed) {
      return (parsed as PersistPayload).data ?? {}
    }
    return parsed as DrawingMap
  } catch {
    return {}
  }
}

/** 写入 localStorage（debounce） */
function persistMap(map: DrawingMap): void {
  if (typeof window === "undefined") return
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    try {
      const payload: PersistPayload = { v: STORAGE_VERSION, data: map }
      localStorage.setItem(DRAWING_STORAGE_KEY, JSON.stringify(payload))
    } catch {
      // 容量不足或隐私模式：静默忽略
    }
  }, SAVE_DEBOUNCE_MS)
}

/** 标准化 symbol/period key（统一大小写与空白） */
function normalizeKey(s: string): string {
  return s.trim().toUpperCase()
}

/** 确保 group 存在，不存在则返回默认值引用 */
function ensureGroup(map: DrawingMap, symbol: string, period: KlinePeriod): DrawGroup {
  const sk = normalizeKey(symbol)
  const pk = String(period)
  if (!map[sk]) map[sk] = {}
  if (!map[sk][pk]) map[sk][pk] = { visible: true, shapes: [] }
  return map[sk][pk]
}

interface DrawingState {
  /** 当前选中的工具 */
  tool: DrawTool
  /** 当前颜色 */
  color: string
  /** 当前线宽 */
  width: number
  /** 画图工具栏是否显示（双击 K 线切出） */
  toolbarVisible: boolean
  /** 当前选中的图形 id（用于 Delete 删除） */
  selectedId: string | null
  /** 全量数据（symbol -> period -> group） */
  map: DrawingMap

  // 动作
  setTool: (tool: DrawTool) => void
  setColor: (color: string) => void
  setWidth: (width: number) => void
  toggleToolbar: () => void
  setToolbarVisible: (visible: boolean) => void
  setSelected: (id: string | null) => void

  /** 读取某合约+周期的 group（只读视图，没有则返回默认） */
  getGroup: (symbol: string, period: KlinePeriod) => DrawGroup

  /** 添加图形 */
  addShape: (symbol: string, period: KlinePeriod, shape: DrawShape) => void
  /** 替换指定图形的两个端点（用于拖拽编辑提交） */
  updateShapeAnchors: (
    symbol: string,
    period: KlinePeriod,
    id: string,
    anchors: [DrawShape["anchors"][0], DrawShape["anchors"][1]],
  ) => void
  /** 只改单端点价格、保留时间（用于工具栏价格输入框精确设置 Y） */
  updateShapeAnchorPrice: (
    symbol: string,
    period: KlinePeriod,
    id: string,
    handle: 0 | 1,
    price: number,
  ) => void
  /** 删除指定图形 */
  removeShape: (symbol: string, period: KlinePeriod, id: string) => void
  /** 删除当前选中图形（需要先 setSelected） */
  removeSelected: (symbol: string, period: KlinePeriod) => void
  /** 清空某合约+周期的全部图形 */
  clearShapes: (symbol: string, period: KlinePeriod) => void
  /** 切换某合约+周期的可见性（隐藏不删除） */
  toggleVisible: (symbol: string, period: KlinePeriod) => void
}

/** 工厂：新建一个 DrawShape（id 自动生成） */
export function createDrawShape(
  tool: Exclude<DrawTool, "cursor">,
  color: string,
  width: number,
  anchors: DrawShape["anchors"],
): DrawShape {
  return {
    id: makeShapeId(),
    tool,
    color,
    width,
    anchors,
    createdAt: Date.now(),
  }
}

export const useDrawingStore = create<DrawingState>((set, get) => ({
  tool: "cursor",
  color: DEFAULT_DRAW_COLOR,
  width: DEFAULT_DRAW_WIDTH,
  toolbarVisible: false,
  selectedId: null,
  map: loadMap(),

  setTool: (tool) => set({ tool, selectedId: tool !== "cursor" ? null : get().selectedId }),
  setColor: (color) => set({ color }),
  setWidth: (width) => set({ width }),
  toggleToolbar: () => set((s) => ({ toolbarVisible: !s.toolbarVisible })),
  setToolbarVisible: (visible) => set({ toolbarVisible: visible }),
  setSelected: (id) => set({ selectedId: id }),

  getGroup: (symbol, period) => {
    const map = get().map
    const sk = normalizeKey(symbol)
    const pk = String(period)
    return map[sk]?.[pk] ?? EMPTY_GROUP
  },

  addShape: (symbol, period, shape) =>
    set((s) => {
      const map: DrawingMap = JSON.parse(JSON.stringify(s.map)) as DrawingMap
      const group = ensureGroup(map, symbol, period)
      group.shapes.push(shape)
      persistMap(map)
      return { map }
    }),

  updateShapeAnchors: (symbol, period, id, anchors) =>
    set((s) => {
      const map: DrawingMap = JSON.parse(JSON.stringify(s.map)) as DrawingMap
      const group = ensureGroup(map, symbol, period)
      const shape = group.shapes.find((sh) => sh.id === id)
      if (!shape) return s
      shape.anchors = anchors
      persistMap(map)
      return { map }
    }),

  updateShapeAnchorPrice: (symbol, period, id, handle, price) =>
    set((s) => {
      if (!Number.isFinite(price)) return s
      const map: DrawingMap = JSON.parse(JSON.stringify(s.map)) as DrawingMap
      const group = ensureGroup(map, symbol, period)
      const shape = group.shapes.find((sh) => sh.id === id)
      if (!shape) return s
      shape.anchors[handle] = { ...shape.anchors[handle], price }
      persistMap(map)
      return { map }
    }),

  removeShape: (symbol, period, id) =>
    set((s) => {
      const map: DrawingMap = JSON.parse(JSON.stringify(s.map)) as DrawingMap
      const group = ensureGroup(map, symbol, period)
      group.shapes = group.shapes.filter((sh) => sh.id !== id)
      persistMap(map)
      const selectedId = s.selectedId === id ? null : s.selectedId
      return { map, selectedId }
    }),

  removeSelected: (symbol, period) => {
    const id = get().selectedId
    if (!id) return
    get().removeShape(symbol, period, id)
  },

  clearShapes: (symbol, period) =>
    set((s) => {
      const map: DrawingMap = JSON.parse(JSON.stringify(s.map)) as DrawingMap
      const group = ensureGroup(map, symbol, period)
      group.shapes = []
      persistMap(map)
      return { map, selectedId: null }
    }),

  toggleVisible: (symbol, period) =>
    set((s) => {
      const map: DrawingMap = JSON.parse(JSON.stringify(s.map)) as DrawingMap
      const group = ensureGroup(map, symbol, period)
      group.visible = !group.visible
      persistMap(map)
      return { map }
    }),
}))
