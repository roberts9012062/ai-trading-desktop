"use client"

/**
 * 流式状态与思考折叠 —— 从 message-renderer 拆出
 */

import { useEffect, useState } from "react"
import { ChevronDown, ChevronRight } from "lucide-react"
import type { ChatBubble } from "@/types"

/** 思考过程折叠区 —— 流式进行中默认展开 */
export function ThinkingBlock({
  content,
  forceExpand,
}: {
  content: string
  forceExpand?: boolean
}): React.JSX.Element | null {
  const [expanded, setExpanded] = useState(Boolean(forceExpand))

  useEffect(() => {
    if (forceExpand) setExpanded(true)
  }, [forceExpand])

  if (!content) return null

  return (
    <div className="mb-2 rounded border border-[var(--border)] overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-1.5 px-2 py-1 text-xs text-[var(--text-muted)] hover:bg-[var(--bg-tertiary)] transition-colors"
      >
        {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <span>思考过程</span>
        {forceExpand ? (
          <span className="ml-1 text-[10px] text-[var(--accent-info)] animate-pulse">
            进行中
          </span>
        ) : null}
      </button>
      {expanded && (
        <div className="px-2 py-1.5 text-xs text-[var(--text-muted)] bg-[var(--bg-tertiary)] whitespace-pre-wrap">
          {content}
          {forceExpand ? (
            <span className="inline-block w-1.5 h-3 ml-0.5 bg-[var(--accent-info)] animate-pulse align-middle" />
          ) : null}
        </div>
      )}
    </div>
  )
}

/** 流式状态条：无正文时也能看到过程 */
export function StreamStatusBar({
  message,
}: {
  message: ChatBubble
}): React.JSX.Element | null {
  if (!message.isStreaming) return null

  const loadingTools = message.toolCalls.filter((t) => t.status === "loading")
  const runningAgents = (message.subAgents ?? []).filter(
    (a) => a.status === "running" || a.status === "pending",
  )
  let label = "正在生成回复…"
  if (runningAgents.length > 0) {
    const done = (message.subAgents ?? []).filter((a) => a.status === "done").length
    label = `子代理调研中：${done}/${message.subAgents.length} 已完成`
  } else if (loadingTools.length > 0) {
    label = `正在调用工具：${loadingTools.map((t) => t.name).join("、")}`
  } else if (message.thinking && !message.content) {
    label = "正在思考…"
  } else if (message.toolCalls.length > 0 && !message.content) {
    label = "工具已完成，正在组织回答…"
  } else if (
    !message.content &&
    !message.thinking &&
    message.toolCalls.length === 0
  ) {
    label = "已连接，等待模型输出…"
  }

  return (
    <div className="mb-2 flex items-center gap-2 px-2 py-1.5 rounded border border-[var(--border)] bg-[var(--bg-tertiary)] text-[11px] text-[var(--text-muted)]">
      <span className="inline-block w-1.5 h-1.5 rounded-full bg-[var(--accent-info)] animate-pulse" />
      <span>{label}</span>
      {message.reactRound > 0 ? (
        <span className="ml-auto text-[10px] text-[var(--accent-info)]">
          第 {message.reactRound}/{message.reactMaxRounds || "?"} 轮
        </span>
      ) : null}
    </div>
  )
}
