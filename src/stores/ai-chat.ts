/**
 * AI 聊天状态管理 —— 对话、消息、模型选择、流式状态
 */

import { create } from "zustand"
import type { AIModel, AIConversationItem, ChatBubble } from "@/types"
import { createConversation, getConversations, deleteConversation, getConversationMessages } from "@/lib/api"
import { streamChat, type MultimodalMessage } from "@/lib/ai-stream"
import { getActiveLocalAi, localStreamChat } from "@/lib/local-ai"
import { useIndicatorStore } from "@/stores/indicator"

/** localStorage key */
const SELECTED_MODEL_KEY = "ai:selected-model"
const MAX_CONTEXT_ROUNDS = 20

// ---------- State 类型 ----------

interface AIChatState {
  /** 当前选中的模型 */
  selectedModel: AIModel | null
  /** 当前对话 ID */
  conversationId: string | null
  /** 对话列表 */
  conversations: AIConversationItem[]
  /** 当前对话的消息列表 */
  messages: ChatBubble[]
  /** 是否正在流式接收中 */
  isStreaming: boolean
  /** 用于中断 SSE 的 AbortController */
  abortController: AbortController | null
  /** 历史侧边栏是否打开 */
  historyOpen: boolean
  /** 待发送的图片（base64 data URL） */
  pendingImages: string[]
  /** 是否有可恢复的任务（上次中断在工具调用中） */
  resumableTask: boolean
  /** 是否有更多历史消息可加载 */
  hasMoreMessages: boolean
  /** 当前消息分页页码 */
  currentMessagePage: number

  // ---------- Actions ----------
  /** 选择模型 */
  selectModel: (model: AIModel) => void
  /** 从 localStorage 恢复模型选择 */
  restoreModel: (models: AIModel[]) => void
  /** 新建对话 */
  newConversation: () => Promise<void>
  /** 加载对话列表 */
  loadConversations: () => Promise<void>
  /** 切换到指定对话 */
  switchConversation: (id: string) => Promise<void>
  /** 删除对话 */
  removeConversation: (id: string) => Promise<void>
  /** 发送消息 */
  sendMessage: (content: string) => Promise<void>
  /** 取消当前流式请求 */
  cancelStream: () => void
  /** 切换历史侧边栏 */
  toggleHistory: () => void
  /** 添加待发送图片 */
  addPendingImage: (dataUrl: string) => void
  /** 移除待发送图片 */
  removePendingImage: (index: number) => void
  /** 清空待发送图片 */
  clearPendingImages: () => void
  /** 加载更早的历史消息 */
  loadMoreMessages: () => Promise<void>
  /** 确认/拒绝工具执行 */
  resolveConfirmation: (bubbleId: string, callId: string, approved: boolean) => void
}

/** 生成唯一 ID */
function uid(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

/** 创建空的助手消息气泡 */
function createAssistantBubble(): ChatBubble {
  return {
    id: uid(),
    role: "assistant",
    content: "",
    thinking: "",
    toolCalls: [],
    toolResults: [],
    confirmations: [],
    subAgents: [],
    reactRound: 0,
    reactMaxRounds: 0,
    isStreaming: true,
    isCancelled: false,
    createdAt: Date.now(),
  }
}

// ---------- Store ----------

export const useAIChatStore = create<AIChatState>((set, get) => ({
  selectedModel: null,
  conversationId: null,
  conversations: [],
  messages: [],
  isStreaming: false,
  abortController: null,
  historyOpen: false,
  pendingImages: [],
  resumableTask: false,
  hasMoreMessages: false,
  currentMessagePage: 1,

  selectModel: (model: AIModel) => {
    localStorage.setItem(SELECTED_MODEL_KEY, model.model_id)
    set({ selectedModel: model })
  },

  restoreModel: (models: AIModel[]) => {
    const savedId = localStorage.getItem(SELECTED_MODEL_KEY)
    if (!savedId || models.length === 0) {
      set({ selectedModel: models[0] ?? null })
      return
    }
    const found = models.find((m) => m.model_id === savedId)
    if (found) {
      set({ selectedModel: found })
    } else {
      // 模型已删除，清除并默认选择第一个
      localStorage.removeItem(SELECTED_MODEL_KEY)
      set({ selectedModel: models[0] ?? null })
    }
  },

  newConversation: async () => {
    const { selectedModel } = get()
    const modelId = selectedModel?.model_id ?? ""
    const conv = await createConversation(modelId)
    set((s) => ({
      conversationId: conv.id,
      messages: [],
      conversations: [conv, ...s.conversations],
      historyOpen: false,
    }))
  },

  loadConversations: async () => {
    const convs = await getConversations()
    set({ conversations: convs })
  },

  switchConversation: async (id: string) => {
    const page = await getConversationMessages(id, 1, 50)
    const bubbles: ChatBubble[] = page.items
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => {
        const dbToolCalls = m.tool_calls as Array<{ name: string; args: string; call_id: string }> | null
        const dbToolResults = m.tool_result as Array<{ name: string; content: string; call_id: string }> | null
        return {
          id: m.id,
          role: m.role as "user" | "assistant",
          content: m.content,
          thinking: "",
          toolCalls: dbToolCalls
            ? dbToolCalls.map((tc) => ({ name: tc.name, args: typeof tc.args === "string" ? tc.args : JSON.stringify(tc.args), callId: tc.call_id, status: "done" as const }))
            : [],
          toolResults: dbToolResults
            ? dbToolResults.map((tr) => ({ name: tr.name, content: tr.content, callId: tr.call_id }))
            : [],
          confirmations: [],
          subAgents: [],
          reactRound: 0,
          reactMaxRounds: 0,
          isStreaming: false,
          isCancelled: false,
          createdAt: new Date(m.created_at).getTime(),
        }
      })

    const lastBubble = bubbles[bubbles.length - 1]
    const resumable = !!(lastBubble?.role === "assistant" && lastBubble.toolCalls.length > 0 && lastBubble.content.length < 20)

    set({
      conversationId: id,
      messages: bubbles,
      historyOpen: false,
      resumableTask: resumable,
      hasMoreMessages: page.items.length >= 50,
      currentMessagePage: 1,
    })
  },

  removeConversation: async (id: string) => {
    await deleteConversation(id)
    const { conversationId, conversations } = get()
    const remaining = conversations.filter((c) => c.id !== id)
    set({ conversations: remaining })
    // 如果删除的是当前对话，切换到最近的或新建
    if (conversationId === id) {
      if (remaining.length > 0) {
        await get().switchConversation(remaining[0].id)
      } else {
        await get().newConversation()
      }
    }
  },

  sendMessage: async (content: string) => {
    const { selectedModel, conversationId, messages, isStreaming, pendingImages } = get()
    if (isStreaming) return
    // 本地直连模式:用户自己的 key 直连 provider,不要求后端模型/会话
    const local = getActiveLocalAi()
    if (!local && !selectedModel) return

    // 确保有对话(本地直连不建服务端会话)
    let convId = conversationId
    if (!local && !convId) {
      const conv = await createConversation(selectedModel!.model_id)
      convId = conv.id
      set((s) => ({
        conversationId: convId,
        conversations: [conv, ...s.conversations],
      }))
    }

    // 构建多模态内容
    const hasImages = pendingImages.length > 0
    const multimodalContent = hasImages
      ? [
          { type: "text" as const, text: content },
          ...pendingImages.map((url) => ({
            type: "image_url" as const,
            image_url: { url },
          })),
        ]
      : content

    // 添加用户消息
    const userBubble: ChatBubble = {
      id: uid(),
      role: "user",
      content: hasImages ? `[图片 x${pendingImages.length}] ${content}` : content,
      thinking: "",
      toolCalls: [],
      toolResults: [],
      confirmations: [],
      subAgents: [],
      reactRound: 0,
      reactMaxRounds: 0,
      isStreaming: false,
      isCancelled: false,
      createdAt: Date.now(),
    }

    // 添加助手占位
    const assistantBubble = createAssistantBubble()
    const newMessages = [...messages, userBubble, assistantBubble]

    set({ messages: newMessages, isStreaming: true, pendingImages: [] })

    // 构建上下文（最近 20 轮 = 40 条消息）
    const contextMessages = buildContext(newMessages)

    // 最后一条用户消息替换为多模态内容
    if (hasImages && contextMessages.length > 0) {
      contextMessages[contextMessages.length - 1] = {
        role: "user",
        content: multimodalContent as MultimodalMessage["content"],
      }
    }

    // 创建 AbortController
    const controller = new AbortController()
    set({ abortController: controller })

    const assistantId = assistantBubble.id

    const indicatorConfig = useIndicatorStore.getState().config

    // 本地直连:纯聊天(增量拼接/thinking/错误),完成后不刷新服务端会话列表
    if (local) {
      await localStreamChat(
        contextMessages,
        {
          onMessage: (chunk) => {
            if (!chunk) return
            set((s) => ({
              messages: s.messages.map((m) =>
                m.id === assistantId ? { ...m, content: m.content + chunk } : m
              ),
            }))
          },
          onThinking: (chunk) => {
            if (!chunk) return
            set((s) => ({
              messages: s.messages.map((m) =>
                m.id === assistantId ? { ...m, thinking: m.thinking + chunk } : m
              ),
            }))
          },
          onError: (msg) => {
            set((s) => ({
              messages: s.messages.map((m) =>
                m.id === assistantId
                  ? { ...m, content: m.content || `❌ ${msg}`, isStreaming: false }
                  : m
              ),
              isStreaming: false,
              abortController: null,
            }))
          },
          onDone: () => {
            set((s) => ({
              messages: s.messages.map((m) =>
                m.id === assistantId ? { ...m, isStreaming: false } : m
              ),
              isStreaming: false,
              abortController: null,
            }))
          },
        },
        controller.signal,
      )
      return
    }

    await streamChat(
      selectedModel!.model_id,
      contextMessages,
      {
        onMessage: (chunk) => {
          if (!chunk) return
          set((s) => ({
            messages: s.messages.map((m) =>
              m.id === assistantId ? { ...m, content: m.content + chunk } : m
            ),
          }))
        },
        onThinking: (chunk) => {
          if (!chunk) return
          set((s) => ({
            messages: s.messages.map((m) =>
              m.id === assistantId ? { ...m, thinking: m.thinking + chunk } : m
            ),
          }))
        },
        // 同 callId 合并（OpenAI 先推 name 再推完整 args；Claude 参数增量）
        onToolCall: (name, args, callId) => {
          set((s) => ({
            messages: s.messages.map((m) => {
              if (m.id !== assistantId) return m
              const existingIdx = m.toolCalls.findIndex(
                (tc) =>
                  (callId && tc.callId === callId) ||
                  (!callId && tc.name === name && tc.status === "loading"),
              )
              if (existingIdx >= 0) {
                const next = [...m.toolCalls]
                const prev = next[existingIdx]
                next[existingIdx] = {
                  ...prev,
                  name: name || prev.name,
                  args: args ? (prev.args && !args.startsWith("{") ? prev.args + args : args) : prev.args,
                  callId: callId || prev.callId,
                  status: "loading",
                }
                return { ...m, toolCalls: next }
              }
              return {
                ...m,
                toolCalls: [
                  ...m.toolCalls,
                  {
                    name: name || "tool",
                    args: args || "",
                    callId: callId || `tmp-${Date.now()}`,
                    status: "loading" as const,
                  },
                ],
              }
            }),
          }))
        },
        onToolResult: (name, result, callId) => {
          // Agent 修改图表指标：应用 apply_config 到 indicator store
          if (
            name === "update_indicator_settings" ||
            name === "get_indicator_settings"
          ) {
            try {
              const parsed = JSON.parse(result) as {
                apply_config?: unknown
                success?: boolean
              }
              if (
                name === "update_indicator_settings" &&
                parsed?.success &&
                parsed.apply_config
              ) {
                useIndicatorStore
                  .getState()
                  .applyConfig(
                    parsed.apply_config as Record<string, unknown>,
                  )
              }
            } catch {
              // 非 JSON 则忽略
            }
          }
          set((s) => ({
            messages: s.messages.map((m) => {
              if (m.id !== assistantId) return m
              const already = m.toolResults.some((tr) => tr.callId === callId)
              return {
                ...m,
                toolResults: already
                  ? m.toolResults
                  : [...m.toolResults, { name, content: result, callId }],
                toolCalls: m.toolCalls.map((tc) =>
                  tc.callId === callId || (!callId && tc.name === name && tc.status === "loading")
                    ? { ...tc, status: "done" as const, callId: callId || tc.callId }
                    : tc
                ),
              }
            }),
          }))
        },
        onConfirmationRequest: (name, args, callId) => {
          set((s) => ({
            messages: s.messages.map((m) =>
              m.id === assistantId
                ? {
                    ...m,
                    confirmations: [
                      ...m.confirmations,
                      { name, args, callId, resolved: false },
                    ],
                  }
                : m
            ),
          }))
        },
        onReactRound: (round, maxRounds) => {
          set((s) => ({
            messages: s.messages.map((m) =>
              m.id === assistantId
                ? { ...m, reactRound: round, reactMaxRounds: maxRounds }
                : m
            ),
          }))
        },
        onSubagentPlan: (agents) => {
          set((s) => ({
            messages: s.messages.map((m) => {
              if (m.id !== assistantId) return m
              return {
                ...m,
                subAgents: agents.map((a) => ({
                  id: a.id,
                  name: a.name,
                  status: (a.status as ChatBubble["subAgents"][0]["status"]) || "pending",
                  symbols: a.symbols,
                  detail: a.symbols?.length
                    ? `${a.symbols.length} 个品种`
                    : undefined,
                })),
              }
            }),
          }))
        },
        onSubagentUpdate: (payload) => {
          set((s) => ({
            messages: s.messages.map((m) => {
              if (m.id !== assistantId) return m
              const idx = m.subAgents.findIndex((a) => a.id === payload.id)
              const nextItem = {
                id: payload.id,
                name: payload.name || payload.id,
                status: (payload.status as ChatBubble["subAgents"][0]["status"]) || "pending",
                detail: payload.detail,
                progress: payload.progress,
                longCount: payload.longCount,
                shortCount: payload.shortCount,
                error: payload.error,
              }
              if (idx < 0) {
                return { ...m, subAgents: [...m.subAgents, nextItem] }
              }
              const next = [...m.subAgents]
              next[idx] = { ...next[idx], ...nextItem }
              return { ...m, subAgents: next }
            }),
          }))
        },
        onError: (msg) => {
          set((s) => ({
            messages: s.messages.map((m) =>
              m.id === assistantId
                ? { ...m, content: m.content || `❌ ${msg}`, isStreaming: false }
                : m
            ),
            isStreaming: false,
            abortController: null,
          }))
        },
        onDone: () => {
          set((s) => ({
            messages: s.messages.map((m) =>
              m.id === assistantId ? { ...m, isStreaming: false } : m
            ),
            isStreaming: false,
            abortController: null,
          }))
          get().loadConversations()
        },
      },
      {
        conversationId: convId ?? undefined,
        signal: controller.signal,
        indicatorConfig,
      },
    )
  },

  cancelStream: () => {
    const { abortController, messages } = get()
    abortController?.abort()
    // 标记最后一条助手消息为已取消
    const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant" && m.isStreaming)
    if (lastAssistant) {
      set((s) => ({
        messages: s.messages.map((m) =>
          m.id === lastAssistant.id ? { ...m, isStreaming: false, isCancelled: true } : m
        ),
        isStreaming: false,
        abortController: null,
      }))
    }
  },

  toggleHistory: () => {
    set((s) => ({ historyOpen: !s.historyOpen }))
  },

  resolveConfirmation: (bubbleId: string, callId: string, approved: boolean) => {
    set((s) => ({
      messages: s.messages.map((m) => {
        if (m.id !== bubbleId) return m
        return {
          ...m,
          confirmations: m.confirmations.map((c) =>
            c.callId === callId ? { ...c, resolved: true } : c
          ),
          content: approved
            ? m.content
            : m.content + `\n\n> 用户已拒绝执行 ${m.confirmations.find((c) => c.callId === callId)?.name ?? "工具"}`,
        }
      }),
    }))
    // 确认后发送 action 消息给后端
    if (approved) {
      const { messages } = get()
      const bubble = messages.find((m) => m.id === bubbleId)
      const confirmation = bubble?.confirmations.find((c) => c.callId === callId)
      if (confirmation) {
        get().sendMessage(`[action:confirm_tool:${callId}]`)
      }
    }
  },

  addPendingImage: (dataUrl: string) => {
    set((s) => ({ pendingImages: [...s.pendingImages, dataUrl] }))
  },

  removePendingImage: (index: number) => {
    set((s) => ({ pendingImages: s.pendingImages.filter((_, i) => i !== index) }))
  },

  clearPendingImages: () => {
    set({ pendingImages: [] })
  },

  loadMoreMessages: async () => {
    const { conversationId, currentMessagePage, hasMoreMessages, messages } = get()
    if (!conversationId || !hasMoreMessages) return

    const nextPage = currentMessagePage + 1
    const page = await getConversationMessages(conversationId, nextPage, 50)

    const olderBubbles: ChatBubble[] = page.items
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => ({
        id: m.id,
        role: m.role as "user" | "assistant",
        content: m.content,
        thinking: "",
        toolCalls: [],
        toolResults: [],
        confirmations: [],
        subAgents: [],
        reactRound: 0,
        reactMaxRounds: 0,
        isStreaming: false,
        isCancelled: false,
        createdAt: new Date(m.created_at).getTime(),
      }))

    if (olderBubbles.length === 0) {
      set({ hasMoreMessages: false })
      return
    }

    set({
      messages: [...olderBubbles, ...messages],
      currentMessagePage: nextPage,
      hasMoreMessages: page.items.length >= 50,
    })
  },
}))

/** 构建上下文消息列表（最近 20 轮） */
function buildContext(messages: ChatBubble[]): Array<MultimodalMessage> {
  const pairs: ChatBubble[] = []
  // 从后往前取，每轮 = user + assistant 配对
  const reversed = [...messages].reverse()
  let rounds = 0
  for (let i = 0; i < reversed.length && rounds < MAX_CONTEXT_ROUNDS; i++) {
    const msg = reversed[i]
    if (msg.role === "assistant" && !msg.isStreaming) {
      const userMsg = reversed[i + 1]
      if (userMsg?.role === "user") {
        pairs.unshift(userMsg, msg)
        rounds++
        i++
      }
    } else if (msg.role === "user" && i === reversed.length - 1) {
      pairs.unshift(msg)
    }
  }
  return pairs.map((m) => ({ role: m.role, content: m.content }))
}
