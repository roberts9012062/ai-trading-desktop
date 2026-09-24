"use client"

import { useState, useMemo } from "react"
import { Search, Plus, Pencil, Trash2, X, Check } from "lucide-react"
import { useAISettingsStore } from "@/stores/ai-settings"
import { CapabilityTags } from "./capability-tags"
import type { AIModel, ProviderTestResult } from "@/types"

interface ModelPanelProps {
  providerId: string | null
  testResults: Record<string, ProviderTestResult>
}

/** 从渠道添加模型弹窗 */
function AddModelsDialog({
  providerId,
  availableModels,
  onClose,
}: {
  providerId: string
  availableModels: string[]
  onClose: () => void
}): React.JSX.Element {
  const { addModels } = useAISettingsStore()
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [search, setSearch] = useState("")
  const [customModelId, setCustomModelId] = useState("")
  const [customDisplayName, setCustomDisplayName] = useState("")
  const [submitting, setSubmitting] = useState(false)

  const filtered = useMemo(
    () => availableModels.filter((m) => m.toLowerCase().includes(search.toLowerCase())),
    [availableModels, search]
  )

  const toggleModel = (modelId: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(modelId)) next.delete(modelId)
      else next.add(modelId)
      return next
    })
  }

  const handleSubmit = async () => {
    if (selected.size === 0 && !customModelId.trim()) return
    setSubmitting(true)
    try {
      const models = Array.from(selected).map((id) => ({
        model_id: id,
        display_name: id,
        is_multimodal: false,
        is_custom: false,
        capabilities: [],
      }))
      if (customModelId.trim()) {
        models.push({
          model_id: customModelId.trim(),
          display_name: customDisplayName.trim() || customModelId.trim(),
          is_multimodal: false,
          is_custom: true,
          capabilities: [],
        })
      }
      await addModels(providerId, models)
      onClose()
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="w-[520px] max-h-[600px] bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg shadow-xl flex flex-col">
        <div className="p-4 border-b border-[var(--border)]">
          <h3 className="text-sm font-medium text-[var(--text-primary)]">从渠道添加模型</h3>
        </div>

        <div className="p-4 space-y-3 flex-1 overflow-y-auto">
          {/* 搜索 */}
          <div className="relative">
            <Search className="absolute left-2.5 top-2 w-3.5 h-3.5 text-[var(--text-muted)]" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="搜索模型..."
              className="w-full pl-8 pr-3 py-1.5 text-xs bg-[var(--bg-tertiary)] border border-[var(--border)] rounded text-[var(--text-primary)] placeholder:text-[var(--text-muted)]"
            />
          </div>

          {/* 已选数量 */}
          {selected.size > 0 && (
            <div className="text-xs text-[var(--text-muted)]">已选 {selected.size} 个模型</div>
          )}

          {/* 模型列表 */}
          <div className="space-y-1 max-h-[300px] overflow-y-auto">
            {filtered.slice(0, 100).map((modelId) => (
              <label
                key={modelId}
                className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-[var(--bg-tertiary)] cursor-pointer"
              >
                <input
                  type="checkbox"
                  checked={selected.has(modelId)}
                  onChange={() => toggleModel(modelId)}
                  className="accent-[var(--primary)]"
                />
                <span className="text-xs text-[var(--text-primary)]">{modelId}</span>
              </label>
            ))}
          </div>

          {/* 自定义模型 */}
          <div className="border-t border-[var(--border)] pt-3 space-y-2">
            <div className="text-xs text-[var(--text-muted)]">添加自定义模型</div>
            <div className="flex gap-2">
              <input
                value={customModelId}
                onChange={(e) => setCustomModelId(e.target.value)}
                placeholder="模型 ID"
                className="flex-1 px-2 py-1 text-xs bg-[var(--bg-tertiary)] border border-[var(--border)] rounded text-[var(--text-primary)]"
              />
              <input
                value={customDisplayName}
                onChange={(e) => setCustomDisplayName(e.target.value)}
                placeholder="显示名称（可选）"
                className="flex-1 px-2 py-1 text-xs bg-[var(--bg-tertiary)] border border-[var(--border)] rounded text-[var(--text-primary)]"
              />
            </div>
          </div>
        </div>

        <div className="flex justify-end gap-2 p-4 border-t border-[var(--border)]">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-xs rounded bg-[var(--bg-tertiary)] text-[var(--text-secondary)]"
          >
            取消
          </button>
          <button
            onClick={handleSubmit}
            disabled={submitting || (selected.size === 0 && !customModelId.trim())}
            className="px-3 py-1.5 text-xs rounded bg-[var(--primary)] text-white disabled:opacity-50"
          >
            {submitting ? "添加中..." : "添加到模型库"}
          </button>
        </div>
      </div>
    </div>
  )
}

export function ModelPanel({ providerId, testResults }: ModelPanelProps): React.JSX.Element {
  const { models, loadingModels, editModel, removeModel } = useAISettingsStore()
  const [search, setSearch] = useState("")
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState("")
  const [showAddDialog, setShowAddDialog] = useState(false)

  const filteredModels = useMemo(() => {
    let list = models
    if (providerId) {
      list = list.filter((m) => m.provider_id === providerId)
    }
    if (search.trim()) {
      const q = search.toLowerCase()
      list = list.filter(
        (m) => m.model_id.toLowerCase().includes(q) || m.display_name.toLowerCase().includes(q)
      )
    }
    return list
  }, [models, providerId, search])

  const handleStartEdit = (model: AIModel) => {
    setEditingId(model.id)
    setEditName(model.display_name)
  }

  const handleSaveEdit = async (id: string) => {
    if (!editName.trim()) return
    await editModel(id, { display_name: editName.trim() })
    setEditingId(null)
  }

  // 当前选中渠道的可用模型（测试结果中获取）
  const availableModels = providerId && testResults[providerId]?.status === "ok"
    ? testResults[providerId].models
    : []

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between p-3 border-b border-[var(--border)]">
        <h2 className="text-sm font-medium text-[var(--text-primary)]">
          模型库 {providerId ? "" : `(${models.length})`}
        </h2>
        <div className="flex items-center gap-2">
          {providerId && (
            <button
              onClick={() => setShowAddDialog(true)}
              className="flex items-center gap-1 px-2 py-1 text-xs rounded bg-[var(--primary)] text-white hover:opacity-90"
            >
              <Plus className="w-3 h-3" /> 添加模型
            </button>
          )}
        </div>
      </div>

      {/* 搜索框 */}
      <div className="p-2 border-b border-[var(--border)]">
        <div className="relative">
          <Search className="absolute left-2.5 top-2 w-3.5 h-3.5 text-[var(--text-muted)]" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索模型..."
            className="w-full pl-8 pr-3 py-1.5 text-xs bg-[var(--bg-tertiary)] border border-[var(--border)] rounded text-[var(--text-primary)] placeholder:text-[var(--text-muted)]"
          />
        </div>
      </div>

      {/* 模型列表 */}
      <div className="flex-1 overflow-y-auto p-2 space-y-1">
        {loadingModels ? (
          <div className="text-xs text-[var(--text-muted)] text-center py-8">加载中...</div>
        ) : filteredModels.length === 0 ? (
          <div className="text-xs text-[var(--text-muted)] text-center py-8">
            {providerId ? "该渠道下暂无模型" : "暂无模型"}
          </div>
        ) : (
          filteredModels.map((model) => (
            <div
              key={model.id}
              className="flex items-center justify-between p-2.5 rounded border border-[var(--border)] hover:bg-[var(--bg-tertiary)] transition-colors"
            >
              <div className="flex-1 min-w-0">
                {editingId === model.id ? (
                  <div className="flex items-center gap-1">
                    <input
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      className="flex-1 px-2 py-0.5 text-xs bg-[var(--bg-tertiary)] border border-[var(--border)] rounded text-[var(--text-primary)]"
                      autoFocus
                    />
                    <button onClick={() => handleSaveEdit(model.id)} className="p-0.5 text-green-400">
                      <Check className="w-3 h-3" />
                    </button>
                    <button onClick={() => setEditingId(null)} className="p-0.5 text-[var(--text-muted)]">
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                ) : (
                  <>
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-[var(--text-primary)] truncate">
                        {model.display_name}
                      </span>
                      {model.is_custom && (
                        <span className="text-[9px] px-1 py-0.5 rounded bg-yellow-500/20 text-yellow-400 border border-yellow-500/30">
                          自定义
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-2 mt-0.5">
                      <span className="text-[10px] text-[var(--text-muted)]">
                        {model.model_id} · {model.provider_name}
                      </span>
                      <CapabilityTags capabilities={model.capabilities ?? []} />
                    </div>
                  </>
                )}
              </div>

              {editingId !== model.id && (
                <div className="flex items-center gap-1 ml-2">
                  <button
                    onClick={() => handleStartEdit(model)}
                    className="p-1 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                  >
                    <Pencil className="w-3 h-3" />
                  </button>
                  <button
                    onClick={() => removeModel(model.id)}
                    className="p-1 rounded hover:bg-red-500/10 text-[var(--text-muted)] hover:text-red-400"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
              )}
            </div>
          ))
        )}
      </div>

      {/* 从渠道添加模型弹窗 */}
      {showAddDialog && providerId && availableModels.length > 0 && (
        <AddModelsDialog
          providerId={providerId}
          availableModels={availableModels}
          onClose={() => setShowAddDialog(false)}
        />
      )}
    </div>
  )
}
