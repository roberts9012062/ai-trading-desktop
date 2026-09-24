"use client"

import { useState, useCallback, useRef, useEffect } from "react"
import { useDisplayStore } from "@/stores/display"
import ReactMarkdown from "react-markdown"
import rehypeHighlight from "rehype-highlight"
import remarkGfm from "remark-gfm"
import { Copy, Check } from "lucide-react"
import { createChart, type IChartApi, ColorType, LineSeries, CandlestickSeries } from "lightweight-charts"
import type { ChatBubble } from "@/types"
import { useAIChatStore } from "@/stores/ai-chat"
import { StreamStatusBar, ThinkingBlock } from "./stream-status"
import { SubAgentList } from "./subagent-list"

/** 复制按钮 */
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }, [text])

  return (
    <button
      onClick={handleCopy}
      className="absolute top-1 right-1 p-1 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] transition-colors"
      title="复制代码"
    >
      {copied ? <Check size={12} /> : <Copy size={12} />}
    </button>
  )
}

/** 工具调用卡片 */
function ToolCallCard({ toolCall, toolResults }: {
  toolCall: ChatBubble["toolCalls"][0]
  toolResults: ChatBubble["toolResults"]
}) {
  const result = toolResults.find((r) => r.callId === toolCall.callId)
  const statusIcon =
    toolCall.status === "loading" ? "⏳" : toolCall.status === "done" ? "✅" : "❌"
  const statusText =
    toolCall.status === "loading"
      ? "执行中…"
      : toolCall.status === "done"
        ? "完成"
        : "失败"

  let argsDisplay = ""
  if (toolCall.args) {
    try {
      const parsed = JSON.parse(toolCall.args)
      argsDisplay = Object.entries(parsed)
        .map(([k, v]) => `${k}: ${String(v)}`)
        .join(", ")
    } catch {
      argsDisplay = toolCall.args
    }
  } else if (toolCall.status === "loading") {
    argsDisplay = "准备参数…"
  }

  let sandboxOutput: string | null = null
  let sandboxError: string | null = null
  if (toolCall.name === "code_sandbox" && result) {
    try {
      const parsed = JSON.parse(result.content)
      if (parsed.success && parsed.stdout) sandboxOutput = parsed.stdout
      if (!parsed.success && parsed.error) sandboxError = parsed.error
    } catch {
      /* 非 JSON 则直接显示 */
    }
  }

  return (
    <div
      className={`my-1.5 rounded border overflow-hidden text-xs ${
        toolCall.status === "loading"
          ? "border-[var(--accent-info)]/50"
          : "border-[var(--border)]"
      }`}
    >
      <div className="flex items-center gap-1.5 px-2 py-1 bg-[var(--bg-tertiary)]">
        <span className={toolCall.status === "loading" ? "animate-pulse" : ""}>
          {statusIcon}
        </span>
        <span className="font-medium text-[var(--text-primary)]">{toolCall.name}</span>
        <span className="text-[10px] text-[var(--text-muted)]">{statusText}</span>
        <span className="text-[var(--text-muted)] truncate flex-1">{argsDisplay}</span>
      </div>
      {result && toolCall.name === "code_sandbox" && (sandboxOutput || sandboxError) ? (
        sandboxError ? (
          <div className="px-2 py-1 text-red-400 whitespace-pre-wrap">{sandboxError}</div>
        ) : (
          <div className="relative">
            <pre className="px-2 py-1 text-[var(--text-primary)] bg-[var(--bg-tertiary)] max-h-48 overflow-auto whitespace-pre-wrap text-[11px] font-mono">
              {sandboxOutput}
            </pre>
            <CopyButton text={sandboxOutput ?? ""} />
          </div>
        )
      ) : result ? (
        <div className="px-2 py-1 text-[var(--text-muted)] max-h-32 overflow-y-auto whitespace-pre-wrap">
          {result.content.length > 500
            ? result.content.slice(0, 500) + "..."
            : result.content}
        </div>
      ) : toolCall.status === "loading" ? (
        <div className="px-2 py-1 text-[10px] text-[var(--accent-info)] animate-pulse">
          正在获取数据…
        </div>
      ) : null}
    </div>
  )
}

/** 交互按钮解析和渲染 */
function ActionButtons({ content, onAction }: { content: string; onAction: (actionId: string) => void }) {
  // 匹配 [button:action_id:label]
  const buttonRegex = /\[button:([^\]:]+):([^\]]+)\]/g
  const parts: Array<{ type: "text" | "button"; value: string; actionId?: string }> = []
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = buttonRegex.exec(content)) !== null) {
    if (match.index > lastIndex) {
      parts.push({ type: "text", value: content.slice(lastIndex, match.index) })
    }
    parts.push({ type: "button", value: match[2], actionId: match[1] })
    lastIndex = match.index + match[0].length
  }
  if (lastIndex < content.length) {
    parts.push({ type: "text", value: content.slice(lastIndex) })
  }

  if (parts.every((p) => p.type === "text")) return null

  return (
    <div className="flex flex-wrap gap-2 mt-2">
      {parts.map((part, i) =>
        part.type === "button" ? (
          <button
            key={i}
            onClick={() => onAction(part.actionId!)}
            className="px-3 py-1 text-xs rounded border border-[var(--accent-info)] text-[var(--accent-info)] hover:bg-[var(--accent-info)] hover:text-white transition-colors"
          >
            {part.value}
          </button>
        ) : (
          <span key={i}>{part.value}</span>
        ),
      )}
    </div>
  )
}

/** 内联图表卡片 */
function ChartCard({ chartData }: { chartData: { type: string; data: unknown[] } }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  // K线涨跌颜色（显示设置自定义）
  const candleUp = useDisplayStore((s) => s.candleUp)
  const candleDown = useDisplayStore((s) => s.candleDown)

  useEffect(() => {
    if (!containerRef.current || chartData.data.length === 0) return

    const chart = createChart(containerRef.current, {
      width: containerRef.current.clientWidth,
      height: 160,
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: "#888" },
      grid: { vertLines: { color: "#333" }, horzLines: { color: "#333" } },
      rightPriceScale: { borderColor: "#444" },
      timeScale: { borderColor: "#444", timeVisible: true },
    })
    chartRef.current = chart

    if (chartData.type === "candle") {
      const series = chart.addSeries(CandlestickSeries, {
        upColor: candleUp, downColor: candleDown,
        borderUpColor: candleUp, borderDownColor: candleDown,
      })
      series.setData(chartData.data as Array<{ time: string; open: number; high: number; low: number; close: number }>)
    } else {
      const series = chart.addSeries(LineSeries, {
        color: "#597ef7",
        lineWidth: 2,
      })
      series.setData(chartData.data as Array<{ time: string; value: number }>)
    }

    chart.timeScale().fitContent()

    return () => {
      chart.remove()
      chartRef.current = null
    }
  }, [chartData, candleUp, candleDown])

  return (
    <div className="my-1.5 rounded border border-[var(--border)] overflow-hidden">
      <div ref={containerRef} className="w-full" />
    </div>
  )
}

/** 从内容中提取 [chart:json] 标记并渲染 */
function ChartExtractor({ content }: { content: string }) {
  const chartRegex = /\[chart:(\{[^}]+\})\]/g
  const charts: Array<{ json: string; key: number }> = []
  let match: RegExpExecArray | null
  let key = 0
  while ((match = chartRegex.exec(content)) !== null) {
    charts.push({ json: match[1], key: key++ })
  }

  if (charts.length === 0) return null

  return (
    <>
      {charts.map((c) => {
        try {
          const data = JSON.parse(c.json)
          return <ChartCard key={c.key} chartData={data} />
        } catch {
          return null
        }
      })}
    </>
  )
}

/** ReAct 推理进度条 */
function ReactProgressBar({ round, maxRounds }: { round: number; maxRounds: number }) {
  if (round <= 0 || maxRounds <= 0) return null
  const pct = Math.min((round / maxRounds) * 100, 100)

  return (
    <div className="mb-2 rounded border border-[var(--border)] overflow-hidden">
      <div className="flex items-center justify-between px-2 py-1 text-[10px] text-[var(--text-muted)]">
        <span>推理步骤 {round}/{maxRounds}</span>
        <span>{Math.round(pct)}%</span>
      </div>
      <div className="h-1 bg-[var(--bg-tertiary)]">
        <div
          className="h-full bg-[var(--accent-info)] transition-all duration-300"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  )
}

/** 工具确认对话框 */
function ConfirmationCard({ confirmation, bubbleId }: {
  confirmation: { name: string; args: string; callId: string; resolved: boolean }
  bubbleId: string
}) {
  const resolveConfirmation = useAIChatStore((s) => s.resolveConfirmation)

  if (confirmation.resolved) return null

  let argsDisplay = ""
  try {
    const parsed = JSON.parse(confirmation.args)
    argsDisplay = Object.entries(parsed)
      .map(([k, v]) => `${k}: ${String(v)}`)
      .join(", ")
  } catch {
    argsDisplay = confirmation.args
  }

  return (
    <div className="my-1.5 rounded border border-[var(--accent-warning)] bg-[var(--bg-tertiary)] overflow-hidden text-xs">
      <div className="flex items-center gap-1.5 px-2 py-1">
        <span>⚠️</span>
        <span className="font-medium text-[var(--text-primary)]">需要确认</span>
        <span className="text-[var(--text-muted)]">{confirmation.name}</span>
      </div>
      {argsDisplay && (
        <div className="px-2 py-1 text-[var(--text-muted)]">{argsDisplay}</div>
      )}
      <div className="flex gap-2 px-2 py-1.5">
        <button
          onClick={() => resolveConfirmation(bubbleId, confirmation.callId, true)}
          className="px-3 py-1 rounded bg-[var(--accent-info)] text-white hover:opacity-80 transition-opacity"
        >
          确认执行
        </button>
        <button
          onClick={() => resolveConfirmation(bubbleId, confirmation.callId, false)}
          className="px-3 py-1 rounded border border-[var(--border)] text-[var(--text-muted)] hover:bg-[var(--bg-secondary)] transition-colors"
        >
          拒绝
        </button>
      </div>
    </div>
  )
}

/** 来源引用提取和渲染 */
function SourceCitations({ content }: { content: string }) {
  // 匹配 📋 来源：xxx 或 "来源：xxx" 模式
  const sourceRegex = /📋\s*来源[：:]\s*(.+)/g
  const citations: string[] = []
  let match: RegExpExecArray | null
  while ((match = sourceRegex.exec(content)) !== null) {
    citations.push(match[1].trim())
  }

  if (citations.length === 0) return null

  return (
    <div className="mt-2 px-2 py-1.5 rounded border border-[var(--border)] bg-[var(--bg-tertiary)]">
      <div className="text-[10px] font-medium text-[var(--text-muted)] mb-1">📋 来源引用</div>
      {citations.map((c, i) => (
        <div key={i} className="text-[10px] text-[var(--accent-info)]">{c}</div>
      ))}
    </div>
  )
}

/** 单条消息渲染 */
export function MessageBubble({ message }: { message: ChatBubble }): React.JSX.Element {
  const sendMessage = useAIChatStore((s) => s.sendMessage)
  const isUser = message.role === "user"

  const handleAction = (actionId: string) => {
    sendMessage(`[action:${actionId}]`)
  }

  return (
    <div className={`px-3 py-2 ${isUser ? "flex justify-end" : ""}`}>
      {isUser ? (
        // 用户消息气泡
        <div className="max-w-[85%] px-3 py-2 rounded-lg bg-[var(--accent-info)] text-white text-xs whitespace-pre-wrap break-words">
          {message.content}
        </div>
      ) : (
        // 助手消息
        <div className="max-w-full">
          {/* 流式状态（无正文时也显示过程） */}
          <StreamStatusBar message={message} />

          {/* 多品种调研子代理列表 */}
          <SubAgentList agents={message.subAgents ?? []} />

          {/* ReAct 推理进度 */}
          {message.isStreaming && (
            <ReactProgressBar round={message.reactRound} maxRounds={message.reactMaxRounds} />
          )}

          {/* 思考 + 工具调用（有步骤编号时按推理步骤渲染） */}
          {(message.thinking || message.toolCalls.length > 0) && message.reactRound > 0 ? (
            <div className="mb-2 rounded border border-[var(--border)] overflow-hidden">
              <div className="flex items-center gap-1.5 px-2 py-1 bg-[var(--bg-tertiary)] text-[10px] font-medium text-[var(--text-muted)]">
                <span>🔄 推理过程</span>
                <span className="text-[var(--accent-info)]">{message.toolCalls.length} 步</span>
              </div>
              {message.thinking ? (
                <ThinkingBlock content={message.thinking} forceExpand={message.isStreaming} />
              ) : null}
              {message.toolCalls.map((tc, i) => (
                <div key={tc.callId || `${tc.name}-${i}`} className="border-t border-[var(--border)]">
                  <div className="px-2 py-0.5 text-[10px] text-[var(--text-muted)] bg-[var(--bg-tertiary)]">
                    步骤 {i + 1}/{message.toolCalls.length}
                  </div>
                  <ToolCallCard toolCall={tc} toolResults={message.toolResults} />
                </div>
              ))}
            </div>
          ) : (
            <>
              <ThinkingBlock
                content={message.thinking}
                forceExpand={message.isStreaming && Boolean(message.thinking)}
              />
              {message.toolCalls.map((tc, i) => (
                <ToolCallCard
                  key={tc.callId || `${tc.name}-${i}`}
                  toolCall={tc}
                  toolResults={message.toolResults}
                />
              ))}
            </>
          )}

          {/* 确认请求 */}
          {message.confirmations.map((c) => (
            <ConfirmationCard
              key={c.callId}
              confirmation={c}
              bubbleId={message.id}
            />
          ))}

          {/* Markdown 内容 */}
          {message.content && (
            <div className="text-xs leading-relaxed text-[var(--text-primary)] prose prose-invert prose-xs max-w-none [&_pre]:relative [&_pre]:bg-[var(--bg-tertiary)] [&_pre]:rounded [&_pre]:p-3 [&_pre]:overflow-x-auto [&_code]:text-[var(--text-primary)] [&_a]:text-[var(--accent-info)] [&_table]:text-xs [&_th]:px-2 [&_td]:px-2 [&_th]:py-1 [&_td]:py-1 [&_th]:border [&_td]:border [&_th]:border-[var(--border)] [&_td]:border-[var(--border)]">
              <ReactMarkdown
                rehypePlugins={[rehypeHighlight]}
                remarkPlugins={[remarkGfm]}
                components={{
                  pre: ({ children }) => <pre className="relative group">{children}</pre>,
                  code: ({ className, children, ...props }) => {
                    const isBlock = className?.includes("language-")
                    const codeText = String(children).replace(/\n$/, "")

                    if (isBlock) {
                      return (
                        <div className="relative">
                          <code className={className} {...props}>
                            {children}
                          </code>
                          <CopyButton text={codeText} />
                        </div>
                      )
                    }
                    return (
                      <code className="px-1 py-0.5 rounded bg-[var(--bg-tertiary)] text-[var(--text-primary)]" {...props}>
                        {children}
                      </code>
                    )
                  },
                }}
              >
                {message.content}
              </ReactMarkdown>
            </div>
          )}

          {/* 来源引用 */}
          {!message.isStreaming && <SourceCitations content={message.content} />}

          {/* 图表渲染 */}
          {!message.isStreaming && <ChartExtractor content={message.content} />}

          {/* 交互按钮 */}
          <ActionButtons content={message.content} onAction={handleAction} />

          {/* 流式光标 */}
          {message.isStreaming && (
            <span className="inline-block w-1.5 h-4 ml-0.5 bg-[var(--accent-info)] animate-pulse" />
          )}

          {/* 取消标记 */}
          {message.isCancelled && (
            <span className="text-[10px] text-[var(--text-muted)] ml-2">已取消</span>
          )}
        </div>
      )}
    </div>
  )
}
