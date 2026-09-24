"use client"

/**
 * 可排序卡片外壳 —— dnd-kit sortable
 *
 * 拖动时：被拖卡片的原位变暗占位，其余卡片实时位移补位（FLIP 过渡）；
 * DragOverlay 由面板渲染跟随鼠标的悬浮克隆。
 */

import { useSortable } from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import { cn } from "@/lib/utils"

export function SortableCard({
  id,
  children,
  className,
}: {
  id: string
  children: React.ReactNode
  className?: string
}): React.JSX.Element {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id })

  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        className,
        isDragging && "opacity-25 ring-2 ring-dashed ring-[var(--primary)]/50 z-10",
        "cursor-grab active:cursor-grabbing touch-none select-none",
      )}
    >
      {children}
    </div>
  )
}
