"use client"

import { useEffect, useState } from "react"
import { Brain, Trash2, RefreshCw, Loader2, Tag } from "lucide-react"
import {
  getAIMemories,
  deleteAIMemory,
  deleteAIPreference,
  type AIMemoryItem,
  type AIPreferenceItem,
} from "@/lib/api"

/** AI 记忆管理面板 */
export function MemoryPanel(): React.JSX.Element {
  const [memories, setMemories] = useState<AIMemoryItem[]>([])
  const [preferences, setPreferences] = useState<AIPreferenceItem[]>([])
  const [loading, setLoading] = useState(false)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<"memory" | "preference">("memory")

  async function fetchData() {
    setLoading(true)
    try {
      const data = await getAIMemories()
      setMemories(data.memories)
      setPreferences(data.preferences)
    } catch {
      // 静默失败
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchData()
  }, [])

  async function handleDeleteMemory(id: string) {
    setDeleting(id)
    try {
      await deleteAIMemory(id)
      setMemories((prev) => prev.filter((m) => m.id !== id))
    } catch {
      // 静默失败
    } finally {
      setDeleting(null)
    }
  }

  async function handleDeletePreference(id: string) {
    setDeleting(id)
    try {
      await deleteAIPreference(id)
      setPreferences((prev) => prev.filter((p) => p.id !== id))
    } catch {
      // 静默失败
    } finally {
      setDeleting(null)
    }
  }

  const categoryColors: Record<string, string> = {
    trading_style: "text-blue-400 bg-blue-500/10",
    preference: "text-purple-400 bg-purple-500/10",
    focus: "text-green-400 bg-green-500/10",
  }

  return (
    <div className="flex flex-col h-full">
      {/* 顶部标题栏 */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border)]">
        <h2 className="text-sm font-medium text-[var(--text-primary)]">AI 记忆管理</h2>
        <button
          onClick={fetchData}
          disabled={loading}
          className="p-1.5 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors disabled:opacity-50"
          title="刷新"
        >
          <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
        </button>
      </div>

      {/* Tab 切换 */}
      <div className="flex border-b border-[var(--border)]">
        <button
          onClick={() => setActiveTab("memory")}
          className={`flex-1 px-3 py-2 text-xs transition-colors ${
            activeTab === "memory"
              ? "text-[var(--accent-info)] border-b-2 border-[var(--accent-info)]"
              : "text-[var(--text-muted)] hover:text-[var(--text-primary)]"
          }`}
        >
          <Brain size={12} className="inline mr-1" />
          对话记忆 ({memories.length})
        </button>
        <button
          onClick={() => setActiveTab("preference")}
          className={`flex-1 px-3 py-2 text-xs transition-colors ${
            activeTab === "preference"
              ? "text-[var(--accent-info)] border-b-2 border-[var(--accent-info)]"
              : "text-[var(--text-muted)] hover:text-[var(--text-primary)]"
          }`}
        >
          <Tag size={12} className="inline mr-1" />
          用户偏好 ({preferences.length})
        </button>
      </div>

      {/* 内容区 */}
      <div className="flex-1 overflow-y-auto">
        {loading && memories.length === 0 && preferences.length === 0 ? (
          <div className="flex items-center justify-center h-32 text-xs text-[var(--text-muted)]">
            <Loader2 size={16} className="animate-spin mr-2" /> 加载中...
          </div>
        ) : activeTab === "memory" ? (
          memories.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-32 text-xs text-[var(--text-muted)] gap-2">
              <Brain size={24} />
              <span>暂无对话记忆</span>
              <span className="text-[10px]">AI 会自动从对话中提取并记住重要信息</span>
            </div>
          ) : (
            <div className="divide-y divide-[var(--border)]">
              {memories.map((mem) => (
                <div
                  key={mem.id}
                  className="px-4 py-3 hover:bg-[var(--bg-tertiary)] transition-colors"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      {mem.title && (
                        <div className="text-xs font-medium text-[var(--text-primary)] mb-1">
                          {mem.title}
                        </div>
                      )}
                      <div className="text-[11px] text-[var(--text-muted)] line-clamp-3">
                        {mem.summary}
                      </div>
                    </div>
                    <button
                      onClick={() => handleDeleteMemory(mem.id)}
                      disabled={deleting === mem.id}
                      className="p-1 rounded text-[var(--text-muted)] hover:text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-50 shrink-0"
                      title="删除"
                    >
                      {deleting === mem.id ? (
                        <Loader2 size={12} className="animate-spin" />
                      ) : (
                        <Trash2 size={12} />
                      )}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )
        ) : preferences.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-32 text-xs text-[var(--text-muted)] gap-2">
            <Tag size={24} />
            <span>暂无用户偏好</span>
            <span className="text-[10px]">AI 会从对话中自动学习您的偏好</span>
          </div>
        ) : (
          <div className="divide-y divide-[var(--border)]">
            {preferences.map((pref) => (
              <div
                key={pref.id}
                className="px-4 py-3 hover:bg-[var(--bg-tertiary)] transition-colors"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 mb-1">
                      <span className={`px-1.5 py-0.5 rounded text-[10px] ${categoryColors[pref.category] ?? "text-[var(--text-muted)] bg-[var(--bg-tertiary)]"}`}>
                        {pref.category}
                      </span>
                    </div>
                    <div className="text-[11px] text-[var(--text-primary)]">
                      {pref.preference}
                    </div>
                  </div>
                  <button
                    onClick={() => handleDeletePreference(pref.id)}
                    disabled={deleting === pref.id}
                    className="p-1 rounded text-[var(--text-muted)] hover:text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-50 shrink-0"
                    title="删除"
                  >
                    {deleting === pref.id ? (
                      <Loader2 size={12} className="animate-spin" />
                    ) : (
                      <Trash2 size={12} />
                    )}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
