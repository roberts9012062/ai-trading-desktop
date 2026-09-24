"use client"

/**
 * K 线画图工具栏
 *
 * 位置：K 线顶部「周期/指标」栏右侧（与指标按钮同行）。
 * 显隐：默认隐藏，由「双击 K 线」切出（useDrawingOverlay 内部处理）。
 *
 * 包含：
 * - 工具按钮组：光标 / 直线 / 斜线(射线) / 箭头
 * - 颜色色板（8 色）
 * - 线宽选择（1/2/3/4）
 * - 显隐开关（眼睛图标）
 * - 清空按钮（带二次确认）
 *
 * 组件只读写 useDrawingStore，不直接操作 canvas。重绘由 overlay hook 订阅 store 触发。
 */

import { useEffect, useRef, useState } from "react"
import {
  MousePointer2,
  Minus,
  TrendingUp,
  MoveUpRight,
  Trash2,
  Eye,
  EyeOff,
  Pencil,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { useDrawingStore } from "@/stores/drawing"
import { useContractSpecStore } from "@/stores/contract-spec"
import { DRAW_COLORS, DRAW_WIDTHS, TOOL_OPTIONS, type DrawShape } from "./draw-types"
import type { KlinePeriod } from "@/types"

/** 按品种 tick 吸附价格 */
function snapByTick(price: number, tick: number): number {
  if (!Number.isFinite(price)) return price
  if (tick > 0 && tick !== 1) {
    return Number((Math.round(price / tick) * tick).toFixed(10))
  }
  return Math.round(price)
}

interface DrawingToolbarProps {
  symbol: string
  period: KlinePeriod
}

/** 工具图标映射 */
const TOOL_ICONS: Record<string, React.ComponentType<{ className?: string; size?: number }>> = {
  cursor: MousePointer2,
  line: Minus,
  ray: TrendingUp,
  arrow: MoveUpRight,
}

export function DrawingToolbar({ symbol, period }: DrawingToolbarProps): React.JSX.Element | null {
  const tool = useDrawingStore((s) => s.tool)
  const color = useDrawingStore((s) => s.color)
  const width = useDrawingStore((s) => s.width)
  const toolbarVisible = useDrawingStore((s) => s.toolbarVisible)
  const setTool = useDrawingStore((s) => s.setTool)
  const setColor = useDrawingStore((s) => s.setColor)
  const setWidth = useDrawingStore((s) => s.setWidth)
  const toggleVisible = useDrawingStore((s) => s.toggleVisible)
  const clearShapes = useDrawingStore((s) => s.clearShapes)

  const group = useDrawingStore((s) => s.getGroup(symbol, period))
  const selectedId = useDrawingStore((s) => s.selectedId)
  const updateShapeAnchorPrice = useDrawingStore((s) => s.updateShapeAnchorPrice)
  const tickSize = useContractSpecStore((s) => s.getTickSize(symbol))
  const decimalPlaces = useContractSpecStore((s) => s.getDecimalPlaces(symbol))

  // 当前选中的图形（用于价格输入框）
  const selectedShape: DrawShape | null = selectedId
    ? group.shapes.find((s) => s.id === selectedId) ?? null
    : null
  const isRay = selectedShape?.tool === "ray"

  // 输入框本地文本缓存（允许输入中间态如 "303"），选中线变化或拖拽端点时同步
  const [leftText, setLeftText] = useState("")
  const [rightText, setRightText] = useState("")
  // 记录上次同步用的价格，避免拖拽高频更新时覆盖用户正在输入的文本
  const lastSyncRef = useRef<{ left: number; right: number } | null>(null)

  useEffect(() => {
    if (!selectedShape) {
      lastSyncRef.current = null
      return
    }
    const lp = selectedShape.anchors[0].price
    const rp = selectedShape.anchors[1].price
    const last = lastSyncRef.current
    // 仅在价格真正变化时同步（拖拽端点会改价格），避免覆盖用户正在输入的文本
    if (!last || last.left !== lp) setLeftText(String(lp))
    if (!last || last.right !== rp) setRightText(String(rp))
    lastSyncRef.current = { left: lp, right: rp }
  }, [selectedShape])

  const commitPrice = (handle: 0 | 1, text: string): void => {
    if (!selectedShape) return
    const num = Number(text)
    if (!Number.isFinite(num)) return
    const snapped = snapByTick(num, tickSize)
    updateShapeAnchorPrice(symbol, period, selectedShape.id, handle, snapped)
    // 立即把吸附后的值写回输入框显示
    if (handle === 0) setLeftText(String(snapped))
    else setRightText(String(snapped))
  }

  const [confirmClear, setConfirmClear] = useState(false)
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 卸载时清理确认态 timer，避免 setState on unmounted
  useEffect(() => {
    return () => {
      if (confirmTimerRef.current !== null) {
        clearTimeout(confirmTimerRef.current)
        confirmTimerRef.current = null
      }
    }
  }, [])

  if (!toolbarVisible) return null

  const shapeCount = group.shapes.length

  return (
    <div
      className="flex items-center gap-2 px-2 py-1 rounded bg-[var(--bg-tertiary)] border border-[var(--border)]"
      // 阻止双击冒泡到 canvas（避免点工具栏时切走工具栏）
      onDoubleClick={(e) => e.stopPropagation()}
    >
      {/* 工具按钮组 */}
      <div className="flex items-center gap-0.5">
        {TOOL_OPTIONS.map((opt) => {
          const Icon = TOOL_ICONS[opt.tool] ?? MousePointer2
          const active = tool === opt.tool
          return (
            <button
              key={opt.tool}
              type="button"
              title={opt.title}
              onClick={() => setTool(opt.tool)}
              className={cn(
                "p-1.5 rounded transition-colors cursor-pointer",
                active
                  ? "bg-[var(--primary)] text-white"
                  : "text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)]",
              )}
            >
              <Icon size={14} />
            </button>
          )
        })}
      </div>

      {/* 分隔 */}
      <span className="w-px h-5 bg-[var(--border)]" />

      {/* 颜色色板 */}
      <div className="flex items-center gap-1">
        {DRAW_COLORS.map((c) => (
          <button
            key={c}
            type="button"
            title={c}
            onClick={() => setColor(c)}
            className={cn(
              "w-4 h-4 rounded-full border cursor-pointer transition-transform",
              color === c
                ? "border-white scale-110 ring-1 ring-white/40"
                : "border-[var(--border)] hover:scale-110",
            )}
            style={{ backgroundColor: c }}
          />
        ))}
      </div>

      {/* 分隔 */}
      <span className="w-px h-5 bg-[var(--border)]" />

      {/* 线宽 */}
      <div className="flex items-center gap-1">
        {DRAW_WIDTHS.map((w) => (
          <button
            key={w}
            type="button"
            title={`线宽 ${w}`}
            onClick={() => setWidth(w)}
            className={cn(
              "flex items-center justify-center w-6 h-6 rounded cursor-pointer transition-colors",
              width === w
                ? "bg-[var(--primary)]/20 ring-1 ring-[var(--primary)]"
                : "hover:bg-[var(--bg-secondary)]",
            )}
          >
            <span
              className="block bg-[var(--text-primary)] rounded-full"
              style={{ width: 14, height: w }}
            />
          </button>
        ))}
      </div>

      {/* 分隔 */}
      <span className="w-px h-5 bg-[var(--border)]" />

      {/* 显隐切换 */}
      <button
        type="button"
        title={group.visible ? "隐藏全部图形（不删除）" : "显示全部图形"}
        onClick={() => toggleVisible(symbol, period)}
        className={cn(
          "p-1.5 rounded transition-colors cursor-pointer",
          group.visible
            ? "text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)]"
            : "text-[var(--text-muted)] bg-[var(--bg-secondary)]",
        )}
      >
        {group.visible ? <Eye size={14} /> : <EyeOff size={14} />}
      </button>

      {/* 清空 */}
      <button
        type="button"
        title="清空当前合约+周期的全部图形"
        onClick={() => {
          if (shapeCount === 0) return
          if (confirmClear) {
            clearShapes(symbol, period)
            setConfirmClear(false)
            if (confirmTimerRef.current !== null) {
              clearTimeout(confirmTimerRef.current)
              confirmTimerRef.current = null
            }
          } else {
            setConfirmClear(true)
            // 3 秒后自动取消确认态
            if (confirmTimerRef.current !== null) clearTimeout(confirmTimerRef.current)
            confirmTimerRef.current = setTimeout(() => {
              confirmTimerRef.current = null
              setConfirmClear(false)
            }, 3000)
          }
        }}
        className={cn(
          "p-1.5 rounded transition-colors cursor-pointer",
          confirmClear
            ? "bg-red-500/20 text-red-400 ring-1 ring-red-500/50"
            : "text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)]",
          shapeCount === 0 && "opacity-40 cursor-not-allowed",
        )}
      >
        <Trash2 size={14} />
      </button>

      {/* 提示 */}
      {confirmClear && (
        <span className="text-xs text-red-400">再点一次确认清空 {shapeCount} 条</span>
      )}

      {/* 选中线的端点价格输入框（只改 Y，X 时间不变） */}
      {selectedShape && (
        <>
          <span className="w-px h-5 bg-[var(--border)]" />
          <div className="flex items-center gap-1">
            <span className="text-[10px] text-[var(--text-muted)]">左端</span>
            <input
              type="number"
              step={tickSize}
              value={leftText}
              onChange={(e) => setLeftText(e.target.value)}
              onBlur={() => commitPrice(0, leftText)}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitPrice(0, leftText)
              }}
              className="w-20 px-1.5 py-0.5 text-xs bg-[var(--bg-secondary)] border border-[var(--border)] rounded text-[var(--text-primary)] focus:outline-none focus:border-[var(--primary)]"
            />
            {!isRay && (
              <>
                <span className="text-[10px] text-[var(--text-muted)]">右端</span>
                <input
                  type="number"
                  step={tickSize}
                  value={rightText}
                  onChange={(e) => setRightText(e.target.value)}
                  onBlur={() => commitPrice(1, rightText)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitPrice(1, rightText)
                  }}
                  className="w-20 px-1.5 py-0.5 text-xs bg-[var(--bg-secondary)] border border-[var(--border)] rounded text-[var(--text-primary)] focus:outline-none focus:border-[var(--primary)]"
                />
              </>
            )}
          </div>
        </>
      )}

      {/* 当前工具提示 */}
      <span className="flex items-center gap-1 text-[10px] text-[var(--text-muted)] ml-1">
        <Pencil size={10} />
        {TOOL_OPTIONS.find((t) => t.tool === tool)?.label ?? "光标"}
      </span>
    </div>
  )
}
