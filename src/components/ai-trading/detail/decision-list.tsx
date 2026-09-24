"use client"

import { useState } from "react"
import type { AITradingDecision } from "@/lib/ai-trading-api"
import { decisionActionLabel } from "@/lib/trade-labels"
import { cn, formatDisplayTime } from "@/lib/utils"

interface DecisionListProps {
  items: AITradingDecision[]
  loading: boolean
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
function DecisionCard({ d }: { d: AITradingDecision }): React.JSX.Element {
  const [showRaw, setShowRaw] = useState(false)
  const isError =
    (d.reason ?? "").startsWith("模型异常") ||
    ((d.reason ?? "").startsWith("模型HTTP") &&
      !(d.reason ?? "").startsWith("模型HTTP2"))
  const parseFailed = isParseFailed(d)
  const raw = parseFailed ? rawOutputOf(d) : null

  return (
    <div
      className={cn(
        "rounded-md border bg-[var(--bg-tertiary)]/40 p-2.5 text-xs",
        isError ? "border-red-500/30" : "border-[var(--border)]",
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

/** 分析/决策记录列表 */
export function DecisionList({
  items,
  loading,
}: DecisionListProps): React.JSX.Element {
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
    <div className="space-y-2 max-h-[360px] overflow-y-auto pr-1">
      {items.map((d) => (
        <DecisionCard key={d.id} d={d} />
      ))}
    </div>
  )
}
