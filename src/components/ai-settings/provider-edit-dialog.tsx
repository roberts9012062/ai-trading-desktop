"use client"

/**
 * 编辑 AI 渠道弹窗 —— 名称 / 规范 / Base URL / API Key（可选）
 */

import { useState } from "react"
import type { AIProvider } from "@/types"
import { useAISettingsStore } from "@/stores/ai-settings"

interface ProviderEditDialogProps {
  provider: AIProvider
  onClose: () => void
}

export function ProviderEditDialog({
  provider,
  onClose,
}: ProviderEditDialogProps): React.JSX.Element {
  const { editProvider } = useAISettingsStore()
  const [name, setName] = useState(provider.name)
  const [apiType, setApiType] = useState<"openai" | "claude" | "jev">(provider.api_type)
  const [baseUrl, setBaseUrl] = useState(provider.base_url)
  const [apiKey, setApiKey] = useState("")
  const [thinkingMode, setThinkingMode] = useState<"auto" | "on" | "off">(
    provider.thinking_enabled === null || provider.thinking_enabled === undefined
      ? "auto"
      : provider.thinking_enabled
        ? "on"
        : "off",
  )
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState("")

  const handleSubmit = async () => {
    if (!name.trim() || !baseUrl.trim()) {
      setError("名称与 Base URL 不能为空")
      return
    }
    setSubmitting(true)
    setError("")
    try {
      const payload: {
        name: string
        api_type: "openai" | "claude" | "jev"
        base_url: string
        api_key?: string
        // 显式 null 表示恢复「跟随模型自动」，与「不改动」区分
        thinking_enabled: boolean | null
      } = {
        name: name.trim(),
        api_type: apiType,
        base_url: baseUrl.trim(),
        thinking_enabled: thinkingMode === "auto" ? null : thinkingMode === "on",
      }
      // 仅在填写了新 Key 时提交，避免误清空
      if (apiKey.trim()) {
        payload.api_key = apiKey.trim()
      }
      await editProvider(provider.id, payload)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存失败")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="w-[480px] bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg shadow-xl">
        <div className="p-4 border-b border-[var(--border)]">
          <h3 className="text-sm font-medium text-[var(--text-primary)]">编辑渠道</h3>
          <p className="mt-1 text-[10px] text-[var(--text-muted)]">
            当前密钥：{provider.api_key_masked || provider.api_key || "****"}
          </p>
        </div>
        <div className="p-4 space-y-3">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="渠道名称"
            className="w-full px-3 py-2 text-sm bg-[var(--bg-tertiary)] border border-[var(--border)] rounded text-[var(--text-primary)] placeholder:text-[var(--text-muted)]"
          />
          <select
            value={apiType}
            onChange={(e) => setApiType(e.target.value as "openai" | "claude" | "jev")}
            className="w-full px-3 py-2 text-sm bg-[var(--bg-tertiary)] border border-[var(--border)] rounded text-[var(--text-primary)]"
          >
            <option value="openai">OpenAI 规范</option>
            <option value="claude">Claude 规范</option>
            <option value="jev">Jev 决策模型（System One）</option>
          </select>
          <input
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="Base URL，如 https://opencode.ai/zen/go"
            className="w-full px-3 py-2 text-sm bg-[var(--bg-tertiary)] border border-[var(--border)] rounded text-[var(--text-primary)] placeholder:text-[var(--text-muted)]"
          />
          <p className="-mt-1 text-[10px] text-[var(--text-muted)]">
            填域名/网关根路径即可；填到 /v1 或完整端点（…/chat/completions）也能自动识别
          </p>
          <input
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            type="password"
            placeholder="新 API Key（留空则不修改）"
            className="w-full px-3 py-2 text-sm bg-[var(--bg-tertiary)] border border-[var(--border)] rounded text-[var(--text-primary)] placeholder:text-[var(--text-muted)]"
          />
          {/* 思考模式开关：仅 Claude 规范渠道（如 MiniMax、Anthropic）支持 */}
          {apiType === "claude" && (
            <div className="space-y-1.5">
              <div className="text-xs text-[var(--text-secondary)]">思考模式（Thinking）</div>
              <div className="flex gap-2">
                {([
                  ["auto", "自动"],
                  ["on", "开启"],
                  ["off", "关闭"],
                ] as const).map(([value, label]) => (
                  <button
                    key={value}
                    onClick={() => setThinkingMode(value)}
                    className={`flex-1 px-3 py-1.5 text-xs rounded ${
                      thinkingMode === value
                        ? "bg-[var(--primary)] text-white"
                        : "bg-[var(--bg-tertiary)] text-[var(--text-secondary)]"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <p className="text-[10px] text-[var(--text-muted)]">
                自动=由模型默认行为决定；强制开启后回答前会先输出思考过程（MiniMax M2
                系列思考常开、无法关闭）
              </p>
            </div>
          )}
          {error ? (
            <div className="text-[10px] text-red-400">{error}</div>
          ) : null}
        </div>
        <div className="flex justify-end gap-2 p-4 border-t border-[var(--border)]">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-xs rounded bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
          >
            取消
          </button>
          <button
            onClick={handleSubmit}
            disabled={submitting}
            className="px-3 py-1.5 text-xs rounded bg-[var(--primary)] text-white disabled:opacity-50"
          >
            {submitting ? "保存中..." : "保存"}
          </button>
        </div>
      </div>
    </div>
  )
}
