"use client"

/**
 * 全局 AI 交易助手浮窗
 * - 浮空按钮：波浪球体 / 悬停展开文字，可拖动
 * - 展开窗口：顶栏拖动 + 右下角改尺寸
 */

import { useCallback, useEffect, useRef } from "react"
import { BotMessageSquare, Minus } from "lucide-react"
import { AiChatPanel } from "@/components/market/ai-chat-panel"
import { FloatFab } from "@/components/ai/float-fab"
import { useAiFloatStore } from "@/stores/ai-float"
import { cn } from "@/lib/utils"

/** 右下角尺寸拖动手柄 */
function ResizeHandle(props: {
  onMouseDown: (e: React.MouseEvent) => void
}): React.JSX.Element {
  return (
    <div
      role="separator"
      aria-label="拖动调整窗口大小"
      onMouseDown={props.onMouseDown}
      className={cn(
        "absolute right-0 bottom-0 w-4 h-4 cursor-se-resize z-30",
        "flex items-end justify-end p-0.5"
      )}
      title="拖动调整大小"
    >
      <svg
        width="10"
        height="10"
        viewBox="0 0 10 10"
        className="text-[var(--text-muted)] opacity-70"
      >
        <path
          d="M9 1 L1 9 M9 5 L5 9 M9 8 L8 9"
          stroke="currentColor"
          strokeWidth="1.2"
          fill="none"
        />
      </svg>
    </div>
  )
}

/** 全局浮窗容器 */
export function FloatingAssistant(): React.JSX.Element {
  const open = useAiFloatStore((s) => s.open)
  const width = useAiFloatStore((s) => s.width)
  const height = useAiFloatStore((s) => s.height)
  const winRight = useAiFloatStore((s) => s.winRight)
  const winBottom = useAiFloatStore((s) => s.winBottom)
  const fabRight = useAiFloatStore((s) => s.fabRight)
  const fabBottom = useAiFloatStore((s) => s.fabBottom)
  const hydrated = useAiFloatStore((s) => s.hydrated)
  const hydrate = useAiFloatStore((s) => s.hydrate)
  const openPanel = useAiFloatStore((s) => s.openPanel)
  const closePanel = useAiFloatStore((s) => s.closePanel)
  const setSize = useAiFloatStore((s) => s.setSize)
  const setWinOffset = useAiFloatStore((s) => s.setWinOffset)
  const setFabOffset = useAiFloatStore((s) => s.setFabOffset)

  const mode = useRef<"idle" | "resize" | "drag">("idle")
  const start = useRef({
    x: 0,
    y: 0,
    w: 0,
    h: 0,
    right: 0,
    bottom: 0,
  })
  const rafId = useRef(0)
  const setSizeRef = useRef(setSize)
  const setWinOffsetRef = useRef(setWinOffset)
  setSizeRef.current = setSize
  setWinOffsetRef.current = setWinOffset

  useEffect(() => {
    hydrate()
  }, [hydrate])

  // 视口变化（缩放/换显示器/调整窗口）时把球和浮窗实时拉回可见区域，
  // 避免按旧视口保存的位置把元素留在屏幕外
  useEffect(() => {
    const onResize = () => {
      const s = useAiFloatStore.getState()
      s.setFabOffset(s.fabRight, s.fabBottom)
      s.setWinOffset(s.winRight, s.winBottom)
    }
    window.addEventListener("resize", onResize)
    return () => window.removeEventListener("resize", onResize)
  }, [])

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (mode.current === "idle") return
      e.preventDefault()
      cancelAnimationFrame(rafId.current)
      rafId.current = requestAnimationFrame(() => {
        const dx = e.clientX - start.current.x
        const dy = e.clientY - start.current.y
        if (mode.current === "resize") {
          setSizeRef.current(start.current.w + dx, start.current.h + dy)
        } else if (mode.current === "drag") {
          setWinOffsetRef.current(
            start.current.right - dx,
            start.current.bottom - dy
          )
        }
      })
    }

    const onUp = () => {
      if (mode.current === "idle") return
      mode.current = "idle"
      document.body.style.userSelect = ""
      document.body.style.cursor = ""
      cancelAnimationFrame(rafId.current)
    }

    document.addEventListener("mousemove", onMove)
    document.addEventListener("mouseup", onUp)
    return () => {
      document.removeEventListener("mousemove", onMove)
      document.removeEventListener("mouseup", onUp)
      cancelAnimationFrame(rafId.current)
    }
  }, [])

  const onResizeDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      mode.current = "resize"
      start.current = {
        x: e.clientX,
        y: e.clientY,
        w: width,
        h: height,
        right: winRight,
        bottom: winBottom,
      }
      document.body.style.userSelect = "none"
      document.body.style.cursor = "se-resize"
    },
    [width, height, winRight, winBottom]
  )

  const onHeaderDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0) return
      const target = e.target as HTMLElement
      if (target.closest("button, a, input, textarea, select")) return
      e.preventDefault()
      mode.current = "drag"
      start.current = {
        x: e.clientX,
        y: e.clientY,
        w: width,
        h: height,
        right: winRight,
        bottom: winBottom,
      }
      document.body.style.userSelect = "none"
      document.body.style.cursor = "move"
    },
    [width, height, winRight, winBottom]
  )

  if (!hydrated) {
    return <></>
  }

  if (!open) {
    return (
      <FloatFab
        right={fabRight}
        bottom={fabBottom}
        onOpen={openPanel}
        onMove={setFabOffset}
      />
    )
  }

  return (
    <div
      className={cn(
        "fixed z-[90] flex flex-col overflow-hidden",
        "rounded-xl border border-[var(--border)]",
        "bg-[var(--bg-secondary)] shadow-2xl"
      )}
      style={{
        width,
        height,
        right: winRight,
        bottom: winBottom,
      }}
      role="dialog"
      aria-label="AI 交易助手"
    >
      <div
        onMouseDown={onHeaderDown}
        className={cn(
          "flex items-center gap-2 px-3 py-1.5 shrink-0",
          "border-b border-[var(--border)] bg-[var(--bg-tertiary)]/60",
          "cursor-move select-none"
        )}
        title="拖动移动窗口"
      >
        <BotMessageSquare
          size={14}
          className="text-[var(--accent-info)] shrink-0"
        />
        <span className="text-xs font-medium text-[var(--text-primary)] flex-1">
          AI 交易助手
        </span>
        <button
          type="button"
          onClick={closePanel}
          className="p-1 rounded hover:bg-[var(--bg-primary)] text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
          title="收起助手"
          aria-label="收起助手"
        >
          <Minus size={14} />
        </button>
      </div>

      <div className="flex-1 min-h-0 relative">
        <AiChatPanel onClose={closePanel} />
        <ResizeHandle onMouseDown={onResizeDown} />
      </div>
    </div>
  )
}
