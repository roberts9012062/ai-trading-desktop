/**
 * AI 本地直连 —— 用户自己的 API key,客户端直连 OpenAI 兼容接口
 *
 * 桌面端已用 plugin-http(Rust 侧 fetch)替换全局 fetch,无 CORS 限制,
 * 可直连任意 provider(openai/deepseek/moonshot/zhipu/openrouter/自建网关等)。
 * 配置存 localStorage(与后端 ai-settings 完全独立,key 不上服务器)。
 * 本地直连为纯聊天:无工具调用/知识库/子代理(那些依赖服务端)。
 */

import type { StreamCallbacks, MultimodalMessage } from "@/lib/ai-stream"

export interface LocalAiProvider {
  id: string
  name: string
  /** 如 https://api.deepseek.com/v1(拼 /chat/completions) */
  baseUrl: string
  apiKey: string
  /** 可用模型 id 列表 */
  models: string[]
}

export interface LocalAiConfig {
  enabled: boolean
  activeProviderId: string
  activeModel: string
  providers: LocalAiProvider[]
}

const STORAGE_KEY = "qh_local_ai_config"

export function getLocalAiConfig(): LocalAiConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as LocalAiConfig
      if (Array.isArray(parsed.providers)) return parsed
    }
  } catch {
    // 损坏则重建
  }
  return { enabled: false, activeProviderId: "", activeModel: "", providers: [] }
}

export function saveLocalAiConfig(config: LocalAiConfig): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(config))
}

/** 当前生效的本地直连配置;未启用/未选全 → null(调用方走服务端) */
export function getActiveLocalAi(): { provider: LocalAiProvider; model: string } | null {
  const config = getLocalAiConfig()
  if (!config.enabled) return null
  const provider = config.providers.find((p) => p.id === config.activeProviderId)
  if (!provider || !config.activeModel) return null
  if (!provider.baseUrl || !provider.apiKey) return null
  return { provider, model: config.activeModel }
}

/**
 * OpenAI 兼容非流式聊天(JSON 输出)。失败抛错(带原因),调用方决定降级;
 * 与 engine.ts 的 localAiDecide 同协议,但把错误暴露给调用方(表单场景
 * 需要向用户呈现失败原因,而非静默 null)。
 */
export async function localChatJson(
  messages: MultimodalMessage[],
  opts: { temperature: number; signal?: AbortSignal },
): Promise<string> {
  const active = getActiveLocalAi()
  if (!active) throw new Error("本地直连未配置完整（provider/model/key）")
  const response = await fetch(
    `${active.provider.baseUrl.replace(/\/$/, "")}/chat/completions`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${active.provider.apiKey}`,
      },
      body: JSON.stringify({
        model: active.model,
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
        temperature: opts.temperature,
        response_format: { type: "json_object" },
        ...(opts.signal ? { signal: opts.signal } : {}),
      }),
    },
  )
  if (!response.ok) {
    const text = await response.text().catch(() => "")
    let detail = text.slice(0, 200)
    try {
      const j = JSON.parse(text)
      detail = j?.error?.message ?? j?.detail ?? detail
    } catch {
      // 非 JSON 原样截断
    }
    throw new Error(`本地直连 HTTP ${response.status}: ${detail || "请求失败"}`)
  }
  const j = (await response.json()) as { choices?: { message?: { content?: string } }[] }
  const content = j.choices?.[0]?.message?.content
  if (!content) throw new Error("本地直连返回空内容")
  return content
}

/**
 * OpenAI 兼容流式聊天。回调适配现有 StreamCallbacks(onMessage 增量拼接;
 * reasoning_content/reasoning → onThinking;错误 → onError)。
 */
export async function localStreamChat(
  messages: MultimodalMessage[],
  callbacks: Pick<StreamCallbacks, "onMessage" | "onThinking" | "onError" | "onDone">,
  signal?: AbortSignal,
): Promise<void> {
  const active = getActiveLocalAi()
  if (!active) {
    callbacks.onError("本地直连未配置完整(provider/model/key)")
    return
  }
  const url = `${active.provider.baseUrl.replace(/\/$/, "")}/chat/completions`

  let response: Response
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${active.provider.apiKey}`,
      },
      body: JSON.stringify({
        model: active.model,
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
        stream: true,
      }),
      signal,
    })
  } catch (err) {
    if (signal?.aborted) {
      callbacks.onDone()
      return
    }
    callbacks.onError(err instanceof Error ? err.message : "网络错误")
    return
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "")
    let detail = text.slice(0, 300)
    try {
      const j = JSON.parse(text)
      detail = j?.error?.message ?? j?.detail ?? detail
    } catch {
      // 非 JSON 原样截断
    }
    callbacks.onError(`HTTP ${response.status}: ${detail || "请求失败"}`)
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
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split("\n")
      buffer = lines.pop() ?? ""
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed.startsWith("data:")) continue
        const payload = trimmed.slice(5).trim()
        if (!payload || payload === "[DONE]") continue
        try {
          const delta = JSON.parse(payload)?.choices?.[0]?.delta
          if (!delta) continue
          const reasoning = delta.reasoning_content ?? delta.reasoning
          if (typeof reasoning === "string" && reasoning) callbacks.onThinking(reasoning)
          if (typeof delta.content === "string" && delta.content) callbacks.onMessage(delta.content)
        } catch {
          // 忽略非 JSON 心跳行
        }
      }
    }
  } catch (err) {
    if (!signal?.aborted) {
      callbacks.onError(err instanceof Error ? err.message : "流式读取中断")
    }
  } finally {
    finishOnce()
  }
}
