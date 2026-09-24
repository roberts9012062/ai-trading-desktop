"use client"

/**
 * 消息中心页面 —— 接 /api/notifications
 * 分类 / 已读筛选 / 展开 / 标记已读 / 删除 / 全部已读；30s 轮询刷新。
 */

import { useState, useMemo, useEffect, useCallback } from "react"
import { cn, formatShanghaiTime } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { ChevronDown, ChevronUp, Check, Trash2 } from "lucide-react"
import type { MessageCategory, Message } from "@/types"
import {
  getNotificationsApi,
  markNotificationReadApi,
  markAllNotificationsReadApi,
  deleteNotificationApi,
} from "@/lib/api"
import { useNotificationsStore } from "@/stores/notifications"

/** 类别筛选选项 */
const CATEGORIES: { value: MessageCategory | "all"; label: string }[] = [
  { value: "all", label: "全部" },
  { value: "system", label: "系统" },
  { value: "risk", label: "风控" },
  { value: "trade", label: "交易" },
  { value: "fund", label: "资金" },
]

/** 类别对应 Badge 样式 */
const CATEGORY_STYLE: Record<
  MessageCategory,
  { label: string; variant: "default" | "outline" | "up" | "destructive" }
> = {
  system: { label: "系统", variant: "default" },
  risk: { label: "风控", variant: "destructive" },
  trade: { label: "交易", variant: "up" },
  fund: { label: "资金", variant: "outline" },
}

const POLL_MS = 30_000

export default function MessagesPage(): React.JSX.Element {
  const [messages, setMessages] = useState<Message[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<MessageCategory | "all">("all")
  const [readFilter, setReadFilter] = useState<"all" | "unread" | "read">("all")
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const data = await getNotificationsApi({ limit: 200 })
      setMessages(data)
    } catch {
      // 未登录或失败时保持原列表
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
    const t = setInterval(() => void load(), POLL_MS)
    return () => clearInterval(t)
  }, [load])

  const filtered = useMemo(() => {
    return messages.filter((m) => {
      const matchCategory = filter === "all" || m.category === filter
      const matchRead =
        readFilter === "all" || (readFilter === "unread" ? !m.read : m.read)
      return matchCategory && matchRead
    })
  }, [messages, filter, readFilter])

  const unreadCount = messages.filter((m) => !m.read).length

  async function handleMarkAllRead(): Promise<void> {
    await markAllNotificationsReadApi()
    setMessages((prev) => prev.map((m) => ({ ...m, read: true })))
    // 同步顶栏红点：后端已全部标记，直接归零（不重复请求后端）
    useNotificationsStore.getState().setUnread(0)
  }

  async function handleToggle(msg: Message): Promise<void> {
    const next = expandedId === msg.id ? null : msg.id
    setExpandedId(next)
    // 展开未读 → 标记已读
    if (next && !msg.read) {
      try {
        await markNotificationReadApi(msg.id)
        setMessages((prev) =>
          prev.map((m) => (m.id === msg.id ? { ...m, read: true } : m)),
        )
        // 同步顶栏红点：本地已标记，-1（不重复请求后端）
        useNotificationsStore.getState().decrementUnread(true)
      } catch {
        // 静默
      }
    }
  }

  async function handleDelete(e: React.MouseEvent, id: string): Promise<void> {
    e.stopPropagation()
    try {
      // 先取被删消息的已读状态，用于判断是否需要递减未读数
      const target = messages.find((m) => m.id === id)
      await deleteNotificationApi(id)
      setMessages((prev) => prev.filter((m) => m.id !== id))
      // 同步顶栏红点：删除未读消息时 -1
      useNotificationsStore.getState().decrementUnread(Boolean(target && !target.read))
    } catch {
      // 静默
    }
  }

  return (
    <div className="flex flex-col h-full">
      {/* 筛选栏 */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-[var(--border)] bg-[var(--bg-secondary)]">
        <div className="flex gap-1">
          {CATEGORIES.map((c) => (
            <Button
              key={c.value}
              variant={filter === c.value ? "default" : "outline"}
              size="sm"
              onClick={() => setFilter(c.value)}
            >
              {c.label}
            </Button>
          ))}
        </div>
        <Separator orientation="vertical" className="h-5" />
        <div className="flex gap-1">
          {(["all", "unread", "read"] as const).map((r) => (
            <Button
              key={r}
              variant={readFilter === r ? "default" : "outline"}
              size="sm"
              onClick={() => setReadFilter(r)}
            >
              {r === "all" ? "全部" : r === "unread" ? `未读 (${unreadCount})` : "已读"}
            </Button>
          ))}
        </div>
        <div className="ml-auto">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void handleMarkAllRead()}
            disabled={unreadCount === 0}
            className="gap-1"
          >
            <Check className="w-3.5 h-3.5" />
            全部已读
          </Button>
        </div>
      </div>

      {/* 消息列表 */}
      <div className="flex-1 overflow-auto">
        {loading ? (
          <div className="flex items-center justify-center h-full text-[var(--text-muted)] text-sm">
            加载中…
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-[var(--text-muted)]">
            <p className="text-lg mb-2">暂无消息</p>
            <p className="text-sm">没有符合条件的消息</p>
          </div>
        ) : (
          <div className="divide-y divide-[var(--border)]">
            {filtered.map((msg) => (
              <MessageItem
                key={msg.id}
                message={msg}
                expanded={expandedId === msg.id}
                onToggle={() => void handleToggle(msg)}
                onDelete={(e) => void handleDelete(e, msg.id)}
              />
            ))}
          </div>
        )}
      </div>

      {/* 底部统计 */}
      <div className="flex items-center gap-4 px-4 py-2 border-t border-[var(--border)] bg-[var(--bg-secondary)] text-xs text-[var(--text-muted)]">
        <span>共 {filtered.length} 条消息</span>
        <span>未读 {unreadCount} 条</span>
      </div>
    </div>
  )
}

/** 消息项 */
function MessageItem(props: {
  message: Message
  expanded: boolean
  onToggle: () => void
  onDelete: (e: React.MouseEvent) => void
}): React.JSX.Element {
  const m = props.message
  const cfg = CATEGORY_STYLE[m.category]

  return (
    <div
      className={cn(
        "px-4 py-3 cursor-pointer transition-colors hover:bg-[var(--bg-tertiary)]/50",
        !m.read && "bg-[var(--primary)]/5",
      )}
      onClick={props.onToggle}
    >
      <div className="flex items-start gap-3">
        {/* 未读圆点 */}
        <div className="mt-1.5 shrink-0">
          {!m.read && (
            <span className="block w-2 h-2 rounded-full bg-[var(--primary)]" />
          )}
        </div>

        {/* 内容 */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <Badge variant={cfg.variant} className="text-[10px]">
              {cfg.label}
            </Badge>
            <span
              className={cn(
                "text-sm font-medium truncate",
                m.read
                  ? "text-[var(--text-secondary)]"
                  : "text-[var(--text-primary)]",
              )}
            >
              {m.title}
            </span>
          </div>

          {props.expanded ? (
            <p className="text-sm text-[var(--text-secondary)] leading-relaxed">
              {m.content}
            </p>
          ) : (
            <p className="text-xs text-[var(--text-muted)] truncate">
              {m.content}
            </p>
          )}
        </div>

        {/* 时间与操作 */}
        <div className="shrink-0 flex flex-col items-end gap-1">
          <span className="font-num text-[10px] text-[var(--text-muted)]">
            {formatShanghaiTime(m.createdAt)}
          </span>
          {props.expanded ? (
            <button
              onClick={props.onDelete}
              className="text-[var(--accent-danger)] hover:opacity-80 cursor-pointer"
              title="删除"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          ) : (
            <ChevronDown className="w-3.5 h-3.5 text-[var(--text-muted)]" />
          )}
          {props.expanded && (
            <ChevronUp className="w-3.5 h-3.5 text-[var(--text-muted)]" />
          )}
        </div>
      </div>
    </div>
  )
}
