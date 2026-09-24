/**
 * SSE 流式消费 —— fetch + ReadableStream，按事件分发
 *
 * 聊天 SSE 优先直连后端（NEXT_PUBLIC_WS_URL / STREAM_URL），
 * 避免经 Next rewrites 时整段缓冲导致「一瞬间出全文」。
 */

import type { StreamEvent } from "@/types"

/** 子代理 plan 项 */
export interface SubAgentPlanPayload {
  id: string
  name: string
  symbols?: string[]
  product_codes?: string[]
  status?: string
}

/** 事件回调 */
export interface StreamCallbacks {
  onMessage: (content: string) => void
  onThinking: (content: string) => void
  onToolCall: (name: string, args: string, callId: string) => void
  onToolResult: (name: string, content: string, callId: string) => void
  onConfirmationRequest: (name: string, args: string, callId: string) => void
  onReactRound: (round: number, maxRounds: number) => void
  onSubagentPlan: (agents: SubAgentPlanPayload[], total: number) => void
  onSubagentUpdate: (payload: {
    id: string
    name: string
    status: string
    detail: string
    progress?: number
    longCount?: number
    shortCount?: number
    error?: string | null
  }) => void
  onError: (message: string) => void
  onDone: () => void
}

/** 流式请求可选参数 */
export interface StreamChatOptions {
  conversationId?: string
  signal?: AbortSignal
  /** 当前图表指标配置，供 Agent 读写 */
  indicatorConfig?: unknown
}

/** 多模态消息 */
export interface MultimodalMessage {
  role: string
  content:
    | string
    | Array<
        | { type: "text"; text: string }
        | { type: "image_url"; image_url: { url: string } }
      >
}

/**
 * 解析 SSE 请求基址
 * 1. NEXT_PUBLIC_STREAM_URL
 * 2. NEXT_PUBLIC_WS_URL（ws→http）
 * 3. NEXT_PUBLIC_API_URL
 * 4. 同域（可能被 Next 缓冲）
 */
function getStreamBase(): string {
  const stream = process.env.NEXT_PUBLIC_STREAM_URL?.trim()
  if (stream) return stream.replace(/\/$/, "")

  const ws = process.env.NEXT_PUBLIC_WS_URL?.trim()
  if (ws) {
    return ws.replace(/^ws/i, "http").replace(/\/$/, "")
  }

  const api = process.env.NEXT_PUBLIC_API_URL?.trim()
  if (api) return api.replace(/\/$/, "")

  return ""
}

/** 发送流式聊天并消费 SSE */
export async function streamChat(
  modelId: string,
  messages: Array<MultimodalMessage>,
  callbacks: StreamCallbacks,
  conversationIdOrOptions?: string | StreamChatOptions,
  maybeSignal?: AbortSignal,
): Promise<void> {
  // 兼容旧签名 (..., conversationId, signal) 与新签名 (..., options)
  let conversationId: string | undefined
  let signal: AbortSignal | undefined
  let indicatorConfig: unknown
  if (
    conversationIdOrOptions &&
    typeof conversationIdOrOptions === "object" &&
    !Array.isArray(conversationIdOrOptions)
  ) {
    conversationId = conversationIdOrOptions.conversationId
    signal = conversationIdOrOptions.signal
    indicatorConfig = conversationIdOrOptions.indicatorConfig
  } else {
    conversationId = conversationIdOrOptions as string | undefined
    signal = maybeSignal
  }

  const token =
    typeof window !== "undefined" ? localStorage.getItem("access_token") : null
  const base = getStreamBase()

  let response: Response
  try {
    response = await fetch(`${base}/api/ai/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        model_id: modelId,
        messages,
        ...(conversationId ? { conversation_id: conversationId } : {}),
        ...(indicatorConfig != null
          ? { indicator_config: indicatorConfig }
          : {}),
      }),
      signal,
      cache: "no-store",
    })
  } catch (err) {
    if (signal?.aborted) {
      callbacks.onDone()
      return
    }
    const message = err instanceof Error ? err.message : "网络错误"
    callbacks.onError(message)
    return
  }

  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: "请求失败" }))
    const detail =
      typeof error?.detail === "string"
        ? error.detail
        : `请求失败: ${response.status}`
    callbacks.onError(detail)
    return
  }

  const reader = response.body?.getReader()
  if (!reader) {
    callbacks.onError("无法读取响应流")
    return
  }

  const decoder = new TextDecoder()
  let buffer = ""
  let finished = false

  const finishOnce = () => {
    if (finished) return
    finished = true
    callbacks.onDone()
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const parts = buffer.split("\n\n")
      buffer = parts.pop() ?? ""

      for (const part of parts) {
        const event = parseSseBlock(part)
        if (!event) continue
        dispatchEvent(event, callbacks)
        if (event.type === "done" || event.type === "error") {
          // error 后仍可能有 done；done 只触发一次
          if (event.type === "done") finishOnce()
        }
      }
    }

    // 残留半包
    if (buffer.trim()) {
      const event = parseSseBlock(buffer)
      if (event) dispatchEvent(event, callbacks)
    }
  } catch (err) {
    if (!signal?.aborted) {
      const message = err instanceof Error ? err.message : "流式读取中断"
      callbacks.onError(message)
    }
  } finally {
    finishOnce()
  }
}

function dispatchEvent(event: StreamEvent, callbacks: StreamCallbacks): void {
  switch (event.type) {
    case "message":
      callbacks.onMessage(event.content ?? "")
      break
    case "thinking":
      callbacks.onThinking(event.content ?? "")
      break
    case "tool_call":
      callbacks.onToolCall(
        event.name ?? "",
        event.arguments ?? "",
        event.call_id ?? "",
      )
      break
    case "tool_result":
      callbacks.onToolResult(
        event.name ?? "",
        event.content ?? "",
        event.call_id ?? "",
      )
      break
    case "confirmation_request":
      callbacks.onConfirmationRequest(
        event.name ?? "",
        event.arguments ?? "",
        event.call_id ?? "",
      )
      break
    case "react_round":
      callbacks.onReactRound(event.round ?? 1, event.max_rounds ?? 5)
      break
    case "subagent_plan":
      callbacks.onSubagentPlan(event.agents ?? [], event.total ?? 0)
      break
    case "subagent_update":
      callbacks.onSubagentUpdate({
        id: event.id ?? "",
        name: event.name ?? "",
        status: event.status ?? "pending",
        detail: event.detail ?? "",
        progress:
          typeof event.progress === "number" ? event.progress : undefined,
        longCount:
          typeof event.long_count === "number" ? event.long_count : undefined,
        shortCount:
          typeof event.short_count === "number" ? event.short_count : undefined,
        error: event.error,
      })
      break
    case "error":
      callbacks.onError(event.message ?? "未知错误")
      break
    case "done":
      break
  }
}

/** 解析单个 SSE 事件块 */
function parseSseBlock(block: string): StreamEvent | null {
  let eventType = ""
  let dataStr = ""

  for (const line of block.split("\n")) {
    if (line.startsWith("event: ")) {
      eventType = line.slice(7).trim()
    } else if (line.startsWith("data: ")) {
      // 多行 data 拼接
      dataStr = dataStr ? `${dataStr}\n${line.slice(6)}` : line.slice(6)
    }
  }

  if (!eventType) return null

  try {
    const data = dataStr ? JSON.parse(dataStr) : {}
    return { type: eventType as StreamEvent["type"], ...data }
  } catch {
    return { type: eventType as StreamEvent["type"] }
  }
}
