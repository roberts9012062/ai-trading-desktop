"use client"

import { useState } from "react"
import { Pencil, Plus, Trash2, Zap } from "lucide-react"
import { useAISettingsStore } from "@/stores/ai-settings"
import type { AIProvider, PresetProvider } from "@/types"
import { ProviderEditDialog } from "./provider-edit-dialog"

interface ProviderPanelProps {
  onSelectProvider: (id: string | null) => void
  selectedProviderId: string | null
}

/** api_type → 徽标文案（jev 为决策模型，非对话规范） */
function apiTypeBadge(apiType: string): string {
  if (apiType === "openai") return "OpenAI 规范"
  if (apiType === "claude") return "Claude 规范"
  if (apiType === "jev") return "Jev 决策模型"
  return apiType
}

/** 添加渠道弹窗内容 */
function AddProviderDialog({
  presets,
  onClose,
}: {
  presets: PresetProvider[]
  onClose: () => void
}): React.JSX.Element {
  const { addProvider } = useAISettingsStore()
  const [mode, setMode] = useState<"preset" | "custom">("preset")
  const [selectedPreset, setSelectedPreset] = useState<PresetProvider | null>(null)
  const [apiKey, setApiKey] = useState("")
  const [customName, setCustomName] = useState("")
  const [customType, setCustomType] = useState<"openai" | "claude" | "jev">("openai")
  const [customUrl, setCustomUrl] = useState("")
  const [thinkingMode, setThinkingMode] = useState<"auto" | "on" | "off">("auto")
  const [submitting, setSubmitting] = useState(false)

  // 当前生效的接口规范：预设取所选预设，自定义取下拉值；思考开关仅 Claude 规范支持
  const effectiveType = mode === "preset" ? selectedPreset?.api_type : customType

  const handleSubmit = async () => {
    if (!apiKey.trim()) return
    setSubmitting(true)
    try {
      const thinking = thinkingMode === "auto" ? null : thinkingMode === "on"
      if (mode === "preset" && selectedPreset) {
        await addProvider({
          name: selectedPreset.name,
          api_type: selectedPreset.api_type,
          base_url: selectedPreset.base_url,
          api_key: apiKey.trim(),
          thinking_enabled: thinking,
        })
      } else if (mode === "custom") {
        if (!customName.trim() || !customUrl.trim()) return
        await addProvider({
          name: customName.trim(),
          api_type: customType,
          base_url: customUrl.trim(),
          api_key: apiKey.trim(),
          thinking_enabled: thinking,
        })
      }
      onClose()
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="w-[480px] bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg shadow-xl">
        <div className="p-4 border-b border-[var(--border)]">
          <h3 className="text-sm font-medium text-[var(--text-primary)]">添加渠道</h3>
        </div>
        <div className="p-4 space-y-4">
          {/* 模式切换 */}
          <div className="flex gap-2">
            <button
              onClick={() => setMode("preset")}
              className={`px-3 py-1.5 text-xs rounded ${mode === "preset" ? "bg-[var(--primary)] text-white" : "bg-[var(--bg-tertiary)] text-[var(--text-secondary)]"}`}
            >
              预设渠道
            </button>
            <button
              onClick={() => setMode("custom")}
              className={`px-3 py-1.5 text-xs rounded ${mode === "custom" ? "bg-[var(--primary)] text-white" : "bg-[var(--bg-tertiary)] text-[var(--text-secondary)]"}`}
            >
              自定义渠道
            </button>
          </div>

          {mode === "preset" ? (
            <div className="space-y-2">
              {presets.map((p) => (
                <button
                  key={p.name}
                  onClick={() => setSelectedPreset(p)}
                  className={`w-full text-left p-3 rounded border transition-colors ${
                    selectedPreset?.name === p.name
                      ? "border-[var(--primary)] bg-[var(--primary)]/10"
                      : "border-[var(--border)] hover:bg-[var(--bg-tertiary)]"
                  }`}
                >
                  <div className="text-sm text-[var(--text-primary)]">{p.name}</div>
                  <div className="text-xs text-[var(--text-muted)]">{p.description}</div>
                </button>
              ))}
            </div>
          ) : (
            <div className="space-y-3">
              <input
                value={customName}
                onChange={(e) => setCustomName(e.target.value)}
                placeholder="渠道名称"
                className="w-full px-3 py-2 text-sm bg-[var(--bg-tertiary)] border border-[var(--border)] rounded text-[var(--text-primary)] placeholder:text-[var(--text-muted)]"
              />
              <select
                value={customType}
                onChange={(e) => setCustomType(e.target.value as "openai" | "claude" | "jev")}
                className="w-full px-3 py-2 text-sm bg-[var(--bg-tertiary)] border border-[var(--border)] rounded text-[var(--text-primary)]"
              >
                <option value="openai">OpenAI 规范</option>
                <option value="claude">Claude 规范</option>
                <option value="jev">Jev 决策模型（System One）</option>
              </select>
              <input
                value={customUrl}
                onChange={(e) => setCustomUrl(e.target.value)}
                placeholder="Base URL（如 https://api.example.com）"
                className="w-full px-3 py-2 text-sm bg-[var(--bg-tertiary)] border border-[var(--border)] rounded text-[var(--text-primary)] placeholder:text-[var(--text-muted)]"
              />
            </div>
          )}

          <input
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            type="password"
            placeholder="API Key"
            className="w-full px-3 py-2 text-sm bg-[var(--bg-tertiary)] border border-[var(--border)] rounded text-[var(--text-primary)] placeholder:text-[var(--text-muted)]"
          />

          {/* 思考模式开关：仅 Claude 规范渠道（如 MiniMax、Anthropic）支持 */}
          {effectiveType === "claude" && (
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
            disabled={submitting || !apiKey.trim() || (mode === "preset" && !selectedPreset)}
            className="px-3 py-1.5 text-xs rounded bg-[var(--primary)] text-white disabled:opacity-50"
          >
            {submitting ? "添加中..." : "确认添加"}
          </button>
        </div>
      </div>
    </div>
  )
}

export function ProviderPanel({ onSelectProvider, selectedProviderId }: ProviderPanelProps): React.JSX.Element {
  const { providers, presets, loadingProviders, testResults, fetchPresets, removeProvider, testProvider } = useAISettingsStore()
  const [showAddDialog, setShowAddDialog] = useState(false)
  const [editingProvider, setEditingProvider] = useState<AIProvider | null>(null)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between p-3 border-b border-[var(--border)]">
        <h2 className="text-sm font-medium text-[var(--text-primary)]">渠道管理</h2>
        <button
          onClick={() => { fetchPresets(); setShowAddDialog(true) }}
          className="flex items-center gap-1 px-2 py-1 text-xs rounded bg-[var(--primary)] text-white hover:opacity-90"
        >
          <Plus className="w-3 h-3" /> 添加
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-2 space-y-2">
        {loadingProviders ? (
          <div className="text-xs text-[var(--text-muted)] text-center py-8">加载中...</div>
        ) : providers.length === 0 ? (
          <div className="text-xs text-[var(--text-muted)] text-center py-8">
            暂无渠道，点击上方添加
          </div>
        ) : (
          providers.map((p) => {
            const testResult = testResults[p.id]
            const isSelected = selectedProviderId === p.id
            return (
              <div
                key={p.id}
                onClick={() => onSelectProvider(isSelected ? null : p.id)}
                className={`p-3 rounded-lg border cursor-pointer transition-colors ${
                  isSelected
                    ? "border-[var(--primary)] bg-[var(--primary)]/5"
                    : "border-[var(--border)] hover:bg-[var(--bg-tertiary)]"
                }`}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-[var(--text-primary)]">{p.name}</span>
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--bg-tertiary)] text-[var(--text-muted)]">
                      {apiTypeBadge(p.api_type)}
                    </span>
                    {p.thinking_enabled === true || p.thinking_enabled === false ? (
                      <span
                        className={`text-[10px] px-1.5 py-0.5 rounded ${
                          p.thinking_enabled
                            ? "bg-amber-500/15 text-amber-400"
                            : "bg-[var(--bg-tertiary)] text-[var(--text-muted)]"
                        }`}
                        title="渠道级思考模式开关"
                      >
                        思考{p.thinking_enabled ? "开" : "关"}
                      </span>
                    ) : null}
                  </div>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={(e) => { e.stopPropagation(); testProvider(p.id) }}
                      className="p-1 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                      title="测试连接"
                    >
                      <Zap className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={(e) => { e.stopPropagation(); setEditingProvider(p) }}
                      className="p-1 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                      title="编辑"
                    >
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={(e) => { e.stopPropagation(); setConfirmDeleteId(p.id) }}
                      className="p-1 rounded hover:bg-red-500/10 text-[var(--text-muted)] hover:text-red-400"
                      title="删除"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>

                <div className="mt-1 text-[10px] text-[var(--text-muted)]">
                  {p.api_key_masked} · {p.model_count} 个模型
                </div>

                {/* 测试结果 */}
                {testResult && (
                  <div className={`mt-1 text-[10px] ${testResult.status === "ok" ? "text-green-400" : "text-red-400"}`}>
                    {testResult.status === "ok" ? "✓ " : "✗ "}
                    {testResult.message}
                  </div>
                )}

                {/* 删除确认 */}
                {confirmDeleteId === p.id && (
                  <div className="mt-2 flex items-center gap-2 text-[10px]">
                    <span className="text-red-400">确认删除此渠道及其所有模型？</span>
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        removeProvider(p.id)
                        setConfirmDeleteId(null)
                      }}
                      className="px-2 py-0.5 rounded bg-red-500/20 text-red-400"
                    >
                      删除
                    </button>
                    <button
                      onClick={(e) => { e.stopPropagation(); setConfirmDeleteId(null) }}
                      className="px-2 py-0.5 rounded bg-[var(--bg-tertiary)] text-[var(--text-secondary)]"
                    >
                      取消
                    </button>
                  </div>
                )}
              </div>
            )
          })
        )}
      </div>

      {showAddDialog && (
        <AddProviderDialog presets={presets} onClose={() => setShowAddDialog(false)} />
      )}
      {editingProvider && (
        <ProviderEditDialog
          provider={editingProvider}
          onClose={() => setEditingProvider(null)}
        />
      )}
    </div>
  )
}
