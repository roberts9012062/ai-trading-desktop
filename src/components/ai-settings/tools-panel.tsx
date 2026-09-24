"use client"

/**
 * AI 工具箱 —— 左分类 / 右工具列表
 * 写操作工具：启用 + 自由交易 双开关
 */

import { useCallback, useEffect, useMemo, useState } from "react"
import { Loader2, RefreshCw, Wrench } from "lucide-react"
import {
  getAITools,
  setAIToolEnabled,
  setAIToolFreeTrade,
  type AIToolItem,
} from "@/lib/api"
import { cn } from "@/lib/utils"
import { ToolRow } from "@/components/ai-settings/tools/tool-row"

/** 按分类分组 */
function groupByCategory(items: AIToolItem[]): Array<{
  category: string
  tools: AIToolItem[]
  enabledCount: number
}> {
  const map = new Map<string, AIToolItem[]>()
  for (const item of items) {
    const list = map.get(item.category) ?? []
    list.push(item)
    map.set(item.category, list)
  }
  return Array.from(map.entries()).map(([category, tools]) => ({
    category,
    tools,
    enabledCount: tools.filter((t) => t.enabled).length,
  }))
}

/** 规范化列表项字段 */
function normalizeTool(t: AIToolItem): AIToolItem {
  return {
    ...t,
    free_trade: Boolean(t.free_trade),
    supports_free_trade: Boolean(
      t.supports_free_trade ?? t.requires_confirmation
    ),
  }
}

/** 工具箱主面板 */
export function ToolsPanel(): React.JSX.Element {
  const [items, setItems] = useState<AIToolItem[]>([])
  const [loading, setLoading] = useState(false)
  const [toggling, setToggling] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [activeCategory, setActiveCategory] = useState<string | null>(null)

  const fetchData = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await getAITools()
      setItems(data.items.map(normalizeTool))
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载工具列表失败")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void fetchData()
  }, [fetchData])

  const groups = useMemo(() => groupByCategory(items), [items])

  useEffect(() => {
    if (groups.length === 0) {
      setActiveCategory(null)
      return
    }
    if (
      !activeCategory ||
      !groups.some((g) => g.category === activeCategory)
    ) {
      setActiveCategory(groups[0].category)
    }
  }, [groups, activeCategory])

  const activeGroup = useMemo(
    () => groups.find((g) => g.category === activeCategory) ?? null,
    [groups, activeCategory]
  )
  const enabledCount = items.filter((t) => t.enabled).length

  const handleToggleEnabled = async (tool: AIToolItem) => {
    const next = !tool.enabled
    setToggling(`${tool.name}:enabled`)
    setError(null)
    setItems((prev) =>
      prev.map((t) =>
        t.name === tool.name ? { ...t, enabled: next } : t
      )
    )
    try {
      await setAIToolEnabled(tool.name, next)
    } catch (err) {
      setItems((prev) =>
        prev.map((t) =>
          t.name === tool.name ? { ...t, enabled: tool.enabled } : t
        )
      )
      setError(err instanceof Error ? err.message : "保存失败")
    } finally {
      setToggling(null)
    }
  }

  const handleToggleFreeTrade = async (tool: AIToolItem) => {
    if (!tool.supports_free_trade) return
    const next = !tool.free_trade
    setToggling(`${tool.name}:free_trade`)
    setError(null)
    setItems((prev) =>
      prev.map((t) =>
        t.name === tool.name ? { ...t, free_trade: next } : t
      )
    )
    try {
      await setAIToolFreeTrade(tool.name, next)
    } catch (err) {
      setItems((prev) =>
        prev.map((t) =>
          t.name === tool.name ? { ...t, free_trade: tool.free_trade } : t
        )
      )
      setError(err instanceof Error ? err.message : "保存自由交易失败")
    } finally {
      setToggling(null)
    }
  }

  return (
    <div className="flex h-full min-h-0 w-full">
      <div className="w-[200px] shrink-0 border-r border-[var(--border)] bg-[var(--bg-secondary)] flex flex-col">
        <div className="px-3 py-3 border-b border-[var(--border)]">
          <div className="flex items-center gap-1.5">
            <Wrench size={13} className="text-[var(--accent-info)]" />
            <span className="text-xs font-medium text-[var(--text-primary)]">
              工具种类
            </span>
          </div>
          <p className="text-[10px] text-[var(--text-muted)] mt-0.5">
            已启用 {enabledCount}/{items.length}
          </p>
        </div>
        <div className="flex-1 overflow-y-auto py-1">
          {loading && items.length === 0 ? (
            <div className="flex justify-center py-8 text-[var(--text-muted)]">
              <Loader2 size={14} className="animate-spin" />
            </div>
          ) : (
            groups.map((group) => {
              const selected = group.category === activeCategory
              return (
                <button
                  key={group.category}
                  type="button"
                  onClick={() => setActiveCategory(group.category)}
                  className={cn(
                    "w-full text-left px-3 py-2.5 transition-colors border-l-2",
                    selected
                      ? "bg-[var(--accent-info)]/10 border-[var(--accent-info)] text-[var(--accent-info)]"
                      : "border-transparent text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
                  )}
                >
                  <div className="text-sm font-medium">{group.category}</div>
                  <div
                    className={cn(
                      "text-[10px] mt-0.5",
                      selected
                        ? "text-[var(--accent-info)]/80"
                        : "text-[var(--text-muted)]"
                    )}
                  >
                    {group.enabledCount}/{group.tools.length} 启用
                  </div>
                </button>
              )
            })
          )}
        </div>
      </div>

      <div className="flex-1 min-w-0 flex flex-col bg-[var(--bg-secondary)]">
        <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border)]">
          <div className="min-w-0">
            <h2 className="text-sm font-medium text-[var(--text-primary)] truncate">
              {activeGroup?.category ?? "工具列表"}
            </h2>
            <p className="text-[10px] text-[var(--text-muted)] mt-0.5">
              {activeGroup?.category === "模拟交易"
                ? "启用：AI 可用；自由：开启后下单/撤单无需确认直接执行"
                : "关闭后 AI 不可见也不可调用该工具"}
            </p>
          </div>
          <button
            type="button"
            onClick={() => void fetchData()}
            disabled={loading}
            className="p-1.5 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors disabled:opacity-50"
            title="刷新"
          >
            <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
          </button>
        </div>

        {error && (
          <div className="mx-4 mt-3 text-[11px] rounded px-2 py-1.5 bg-[var(--accent-danger)]/10 text-[var(--accent-danger)]">
            {error}
          </div>
        )}

        <div className="flex-1 overflow-y-auto px-4 py-3">
          {loading && items.length === 0 ? (
            <div className="flex items-center justify-center py-16 text-[var(--text-muted)] text-xs gap-2">
              <Loader2 size={14} className="animate-spin" />
              加载中…
            </div>
          ) : !activeGroup || activeGroup.tools.length === 0 ? (
            <p className="text-center text-xs text-[var(--text-muted)] py-16">
              该分类下暂无工具
            </p>
          ) : (
            <ul className="space-y-2 max-w-2xl">
              {activeGroup.tools.map((tool) => (
                <ToolRow
                  key={tool.name}
                  tool={tool}
                  toggling={toggling}
                  onToggleEnabled={(t) => void handleToggleEnabled(t)}
                  onToggleFreeTrade={(t) => void handleToggleFreeTrade(t)}
                />
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}
