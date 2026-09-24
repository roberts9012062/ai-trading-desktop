"use client"

import { Trash2, MessageSquare } from "lucide-react"
import { useState } from "react"
import { useAIChatStore } from "@/stores/ai-chat"
import type { AIConversationItem } from "@/types"

/** 对话历史侧边栏 */
export function ChatHistory(): React.JSX.Element {
  const conversations = useAIChatStore((s) => s.conversations)
  const conversationId = useAIChatStore((s) => s.conversationId)
  const switchConversation = useAIChatStore((s) => s.switchConversation)
  const removeConversation = useAIChatStore((s) => s.removeConversation)
  const [confirmId, setConfirmId] = useState<string | null>(null)

  function handleDelete(id: string) {
    if (confirmId === id) {
      removeConversation(id)
      setConfirmId(null)
    } else {
      setConfirmId(id)
      // 3 秒后自动取消确认状态
      setTimeout(() => setConfirmId((prev) => (prev === id ? null : prev)), 3000)
    }
  }

  function formatTime(dateStr: string): string {
    const date = new Date(dateStr)
    const now = new Date()
    const diffMs = now.getTime() - date.getTime()
    const diffMin = Math.floor(diffMs / 60000)
    if (diffMin < 1) return "刚刚"
    if (diffMin < 60) return `${diffMin} 分钟前`
    const diffHour = Math.floor(diffMin / 60)
    if (diffHour < 24) return `${diffHour} 小时前`
    return date.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" })
  }

  return (
    <div className="flex flex-col h-full">
      <div className="px-3 py-2 border-b border-[var(--border)]">
        <span className="text-xs font-medium text-[var(--text-primary)]">对话历史</span>
      </div>
      <div className="flex-1 overflow-y-auto">
        {conversations.length === 0 ? (
          <div className="p-4 text-xs text-[var(--text-muted)] text-center">暂无对话记录</div>
        ) : (
          conversations.map((conv: AIConversationItem) => (
            <div
              key={conv.id}
              onClick={() => switchConversation(conv.id)}
              className={`flex items-start gap-2 px-3 py-2 cursor-pointer hover:bg-[var(--bg-tertiary)] transition-colors border-b border-[var(--border)] ${
                conversationId === conv.id ? "bg-[var(--bg-tertiary)]" : ""
              }`}
            >
              <MessageSquare size={14} className="mt-0.5 shrink-0 text-[var(--text-muted)]" />
              <div className="flex-1 min-w-0">
                <div className="text-xs text-[var(--text-primary)] truncate">{conv.title}</div>
                <div className="text-[10px] text-[var(--text-muted)] mt-0.5">
                  {formatTime(conv.updated_at)}
                </div>
              </div>
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  handleDelete(conv.id)
                }}
                className="shrink-0 p-1 rounded text-[var(--text-muted)] hover:text-red-400 hover:bg-[var(--bg-secondary)] transition-colors"
                title={confirmId === conv.id ? "再次点击确认删除" : "删除对话"}
              >
                <Trash2 size={12} />
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
