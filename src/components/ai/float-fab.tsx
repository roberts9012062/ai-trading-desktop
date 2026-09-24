"use client"

/**
 * 可拖动浮空按钮 —— 黑灰白半液体球
 * 悬停弹性展开「AI 助手」，移开回弹
 */

import { useCallback, useEffect, useRef, useState } from "react"
import { WaveSphere } from "@/components/ai/wave-sphere"
import { cn } from "@/lib/utils"

const DRAG_THRESHOLD = 5

/** 浮空唤起按钮 */
export function FloatFab(props: {
  right: number
  bottom: number
  onOpen: () => void
  onMove: (right: number, bottom: number) => void
}): React.JSX.Element {
  const [hovered, setHovered] = useState(false)
  const [bounce, setBounce] = useState<"in" | "out" | null>(null)
  const dragging = useRef(false)
  const moved = useRef(false)
  const start = useRef({ x: 0, y: 0, right: 0, bottom: 0 })
  const rafId = useRef(0)
  const bounceTimer = useRef(0)
  const onMoveRef = useRef(props.onMove)
  const onOpenRef = useRef(props.onOpen)
  onMoveRef.current = props.onMove
  onOpenRef.current = props.onOpen

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragging.current) return
      e.preventDefault()
      const dx = e.clientX - start.current.x
      const dy = e.clientY - start.current.y
      if (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD) {
        moved.current = true
      }
      cancelAnimationFrame(rafId.current)
      rafId.current = requestAnimationFrame(() => {
        onMoveRef.current(
          start.current.right - dx,
          start.current.bottom - dy
        )
      })
    }

    const onUp = () => {
      if (!dragging.current) return
      dragging.current = false
      document.body.style.userSelect = ""
      document.body.style.cursor = ""
      cancelAnimationFrame(rafId.current)
      if (!moved.current) {
        onOpenRef.current()
      }
    }

    document.addEventListener("mousemove", onMove)
    document.addEventListener("mouseup", onUp)
    return () => {
      document.removeEventListener("mousemove", onMove)
      document.removeEventListener("mouseup", onUp)
      cancelAnimationFrame(rafId.current)
      window.clearTimeout(bounceTimer.current)
    }
  }, [])

  const onDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0) return
      e.preventDefault()
      dragging.current = true
      moved.current = false
      start.current = {
        x: e.clientX,
        y: e.clientY,
        right: props.right,
        bottom: props.bottom,
      }
      document.body.style.userSelect = "none"
      document.body.style.cursor = "grabbing"
    },
    [props.right, props.bottom]
  )

  const handleEnter = useCallback(() => {
    window.clearTimeout(bounceTimer.current)
    setHovered(true)
    setBounce("in")
    bounceTimer.current = window.setTimeout(() => setBounce(null), 520)
  }, [])

  const handleLeave = useCallback(() => {
    window.clearTimeout(bounceTimer.current)
    setHovered(false)
    setBounce("out")
    bounceTimer.current = window.setTimeout(() => setBounce(null), 480)
  }, [])

  return (
    <button
      type="button"
      onMouseDown={onDown}
      onMouseEnter={handleEnter}
      onMouseLeave={handleLeave}
      className={cn(
        "fixed z-[90] flex items-center overflow-hidden",
        "rounded-full border border-[#3a3a3a]",
        "cursor-grab active:cursor-grabbing",
        hovered ? "gap-2.5 pl-1.5 pr-4 py-1.5" : "w-14 h-14 p-0 justify-center",
        hovered ? "bg-[#1f1f1f]/95 backdrop-blur-md" : "bg-transparent",
        bounce === "in" &&
          "animate-[ai-fab-expand_0.5s_cubic-bezier(0.34,1.56,0.64,1)_both]",
        bounce === "out" &&
          "animate-[ai-fab-collapse_0.42s_cubic-bezier(0.34,1.4,0.64,1)_both]",
        !bounce &&
          "transition-[width,padding,background-color,box-shadow] duration-300 ease-out"
      )}
      style={{
        right: props.right,
        bottom: props.bottom,
        boxShadow: hovered
          ? "0 8px 24px rgba(0,0,0,0.45)"
          : "0 4px 14px rgba(0,0,0,0.4)",
      }}
      title="拖动移动 · 点击打开 AI 交易助手"
      aria-label="打开 AI 交易助手"
    >
      <WaveSphere size={hovered ? 40 : 56} compact={hovered} />

      <span
        className={cn(
          "text-sm font-medium text-[#e5e5e5] whitespace-nowrap origin-left",
          hovered
            ? "max-w-[5rem] opacity-100"
            : "max-w-0 opacity-0 overflow-hidden w-0 p-0 m-0",
          bounce === "in" &&
            "animate-[ai-label-in_0.45s_cubic-bezier(0.34,1.56,0.64,1)_both]",
          bounce === "out" && "animate-[ai-label-out_0.3s_ease-in_both]"
        )}
      >
        AI 助手
      </span>

      <style>{`
        @keyframes ai-fab-expand {
          0% { transform: scale(0.88); }
          55% { transform: scale(1.08); }
          75% { transform: scale(0.97); }
          100% { transform: scale(1); }
        }
        @keyframes ai-fab-collapse {
          0% { transform: scale(1.05); }
          40% { transform: scale(0.9); }
          70% { transform: scale(1.06); }
          100% { transform: scale(1); }
        }
        @keyframes ai-label-in {
          0% { opacity: 0; transform: translateX(-10px) scale(0.85); }
          60% { opacity: 1; transform: translateX(2px) scale(1.05); }
          100% { opacity: 1; transform: translateX(0) scale(1); }
        }
        @keyframes ai-label-out {
          0% { opacity: 1; transform: translateX(0); }
          100% { opacity: 0; transform: translateX(-8px) scale(0.9); }
        }
      `}</style>
    </button>
  )
}
