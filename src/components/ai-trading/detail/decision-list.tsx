"use client"

import { useLayoutEffect, useMemo, useRef, useState } from "react"
import type { AITradingDecision } from "@/lib/ai-trading-api"
import { decisionActionLabel } from "@/lib/trade-labels"
import { cn, formatDisplayTime } from "@/lib/utils"

interface DecisionListProps {
  items: AITradingDecision[]
  loading: boolean
  /** 列表归属键（如 taskId）：切换任务时重置动画基准，避免整列表回放入场动画 */
  resetKey?: string
}

/** 模型输出解析失败（含接口异常/空输出/熔断降级）的记录 */
function isParseFailed(d: AITradingDecision): boolean {
  return d.model_output?.parse_ok === false
}

/** 解析失败记录里存的模型原始输出（前 2000 字，供展开排查） */
function rawOutputOf(d: AITradingDecision): string | null {
  const raw = d.model_output?.raw
  return typeof raw === "string" && raw.length > 0 ? raw : null
}

/** 单条分析记录卡片 */
function DecisionCard({
  d,
  fresh,
  elRef,
}: {
  d: AITradingDecision
  fresh: boolean
  elRef?: (el: HTMLDivElement | null) => void
}): React.JSX.Element {
  const [showRaw, setShowRaw] = useState(false)
  const isError =
    (d.reason ?? "").startsWith("模型异常") ||
    ((d.reason ?? "").startsWith("模型HTTP") &&
      !(d.reason ?? "").startsWith("模型HTTP2"))
  const parseFailed = isParseFailed(d)
  const raw = parseFailed ? rawOutputOf(d) : null

  return (
    <div
      ref={elRef}
      className={cn(
        "rounded-md border bg-[var(--bg-tertiary)]/40 p-2.5 text-xs",
        isError ? "border-red-500/30" : "border-[var(--border)]",
        fresh && "decision-enter",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 min-w-0">
          <span
            className={cn(
              "font-medium",
              d.action === "open_long" && "text-up",
              d.action === "open_short" && "text-down",
              d.action === "close" && "text-amber-400",
            )}
          >
            {decisionActionLabel(d.action)}
          </span>
          {isError && (
            <span className="px-1 py-0.5 rounded text-[10px] bg-red-500/20 text-red-300 border border-red-500/30">
              异常
            </span>
          )}
          {parseFailed && !isError && (
            <span className="px-1 py-0.5 rounded text-[10px] bg-amber-500/15 text-amber-300 border border-amber-500/30">
              输出解析失败·已观望
            </span>
          )}
        </span>
        <span className="text-[var(--text-muted)] shrink-0">
          {d.trigger_type} · {formatDisplayTime(d.bar_time)}
        </span>
      </div>
      <p className="mt-1 text-[var(--text-secondary)] leading-relaxed">
        {d.reason || "—"}
      </p>
      <div className="mt-1 text-[10px] text-[var(--text-muted)] flex items-center justify-between">
        <span>{formatDisplayTime(d.created_at)}</span>
        <span className="flex items-center gap-2 min-w-0">
          {d.order_id && (
            <span className="font-mono truncate max-w-[140px]">
              单 {d.order_id.slice(0, 8)}…
            </span>
          )}
          {raw && (
            <button
              type="button"
              onClick={() => setShowRaw((v) => !v)}
              className="shrink-0 underline underline-offset-2 hover:text-[var(--text-primary)] cursor-pointer"
            >
              原始输出{showRaw ? " ▴" : " ▾"}
            </button>
          )}
        </span>
      </div>
      {showRaw && raw && (
        <pre className="mt-1.5 max-h-40 overflow-y-auto whitespace-pre-wrap break-all rounded bg-[var(--bg-secondary)] p-1.5 text-[10px] leading-relaxed text-[var(--text-muted)]">
          {raw.slice(0, 1500)}
          {raw.length > 1500 ? "\n…（截断）" : ""}
        </pre>
      )}
    </div>
  )
}

/** 分析/决策记录列表 —— 实时动态：
 * 新记录从顶部滑入（琥珀高亮渐隐），旧记录 FLIP 平滑下移；
 * 数据由上层轮询刷新（resetKey 变更=切换任务，重置动画基准）。 */
export function DecisionList({
  items,
  loading,
  resetKey,
}: DecisionListProps): React.JSX.Element {
  // 已见过的记录 id（判定"新记录"）；切换任务时同步清空（渲染期，先于首屏
  // 计算，避免切任务瞬间用旧任务的 knownIds 把整列表误判为"新"回放入场动画）
  const knownIdsRef = useRef<Set<string>>(new Set())
  const resetKeyRef = useRef<string | undefined>(resetKey)

  // 渲染期计算新到达的 id（knownIds 尚未更新），仅非首屏时标记入场动画
  const freshIds = useMemo(() => {
    if (resetKeyRef.current !== resetKey) {
      resetKeyRef.current = resetKey
      knownIdsRef.current = new Set()
    }
    const fresh = new Set<string>()
    const known = knownIdsRef.current
    const firstScreen = known.size === 0
    for (const d of items) {
      if (!known.has(d.id) && !firstScreen) fresh.add(d.id)
      known.add(d.id)
    }
    return fresh
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, resetKey])

  // FLIP：记录每条上一次的纵向位置，列表变化时先反向位移再过渡回 0
  const containerRef = useRef<HTMLDivElement | null>(null)
  const itemEls = useRef(new Map<string, HTMLDivElement>())
  const prevTops = useRef(new Map<string, number>())

  useLayoutEffect(() => {
    const els = itemEls.current
    const tops = new Map<string, number>()
    els.forEach((el, id) => {
      // 仍在视口外很远的元素跳过测量（省 getBoundingClientRect 开销意义不大，直接全量测）
      tops.set(id, el.getBoundingClientRect().top)
    })
    let moved = false
    tops.forEach((top, id) => {
      const prev = prevTops.current.get(id)
      if (prev == null) return
      const delta = prev - top
      if (Math.abs(delta) < 1) return
      const el = els.get(id)
      if (!el) return
      el.style.transition = "none"
      el.style.transform = `translateY(${delta}px)`
      moved = true
    })
    if (moved && containerRef.current) {
      // 强制回流后释放 transform，让位移以过渡动画展开（旧内容平滑下移）
      void containerRef.current.offsetHeight
      tops.forEach((_top, id) => {
        const el = els.get(id)
        if (el && el.style.transform) {
          el.style.transition =
            "transform 480ms cubic-bezier(0.22, 1, 0.36, 1)"
          el.style.transform = ""
        }
      })
    }
    prevTops.current = tops
    // 清理已卸载元素的 ref
    for (const id of [...els.keys()]) {
      if (!tops.has(id)) els.delete(id)
    }
  }, [items])

  if (loading) {
    return (
      <p className="text-xs text-[var(--text-muted)] py-6 text-center">加载中…</p>
    )
  }
  if (items.length === 0) {
    return (
      <p className="text-xs text-[var(--text-muted)] py-6 text-center">
        暂无分析记录
      </p>
    )
  }
  return (
    <div
      ref={containerRef}
      className="space-y-2 max-h-[360px] overflow-y-auto pr-1"
    >
      {items.map((d) => (
        <DecisionCard
          key={d.id}
          d={d}
          fresh={freshIds.has(d.id)}
          elRef={(el) => {
            if (el) itemEls.current.set(d.id, el)
            else itemEls.current.delete(d.id)
          }}
        />
      ))}
    </div>
  )
}
