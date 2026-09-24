"use client"

/**
 * 收藏面板 —— 用户配方库（可改名）
 */

import { useState } from "react"
import {
  patchFactorFavorite,
  type FactorFavoriteItem,
} from "@/lib/factor-lab-api"

interface FavoritesPanelProps {
  items: FactorFavoriteItem[]
  loading: boolean
  onSelect: (item: FactorFavoriteItem) => void
  onDelete: (id: string) => void
  onRefresh: () => void
}

/** 收藏列表 */
export function FavoritesPanel(
  props: FavoritesPanelProps,
): React.JSX.Element {
  const { items, loading, onSelect, onDelete, onRefresh } = props
  const [editId, setEditId] = useState<string | null>(null)
  const [editName, setEditName] = useState("")
  const [saving, setSaving] = useState(false)

  async function saveName(id: string): Promise<void> {
    const name = editName.trim()
    if (!name) {
      setEditId(null)
      return
    }
    setSaving(true)
    try {
      await patchFactorFavorite(id, { name })
      setEditId(null)
      onRefresh()
    } finally {
      setSaving(false)
    }
  }

  function startEdit(it: FactorFavoriteItem): void {
    setEditId(it.id)
    setEditName(it.name)
  }

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)] p-3 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-medium text-[var(--text-secondary)]">
          我的收藏
        </h2>
        <button
          type="button"
          onClick={onRefresh}
          className="text-[10px] text-[var(--text-muted)] hover:text-[var(--text-primary)]"
        >
          刷新
        </button>
      </div>
      <p className="text-[10px] text-[var(--text-muted)]">
        收藏可在 AI 交易「因子公式」任务中下拉选用；点「改名」可修改名称。
      </p>
      {loading ? (
        <div className="text-[11px] text-[var(--text-muted)] py-2">加载中…</div>
      ) : items.length === 0 ? (
        <div className="text-[11px] text-[var(--text-muted)] py-2">
          暂无收藏。在 Champion 或历史上点「收藏」。
        </div>
      ) : (
        <ul className="space-y-1.5 max-h-56 overflow-y-auto">
          {items.map((it) => (
            <li
              key={it.id}
              className="rounded-md border border-[var(--border)] bg-[var(--bg-tertiary)]/40 px-2 py-1.5 text-[11px]"
            >
              {editId === it.id ? (
                <div className="flex gap-1">
                  <input
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    className="flex-1 h-7 rounded border border-[var(--border)] bg-[var(--bg-secondary)] px-1.5 text-[11px] text-[var(--text-primary)]"
                    autoFocus
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void saveName(it.id)
                      if (e.key === "Escape") setEditId(null)
                    }}
                  />
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => void saveName(it.id)}
                    className="text-[10px] px-1.5 text-[var(--primary)] hover:underline disabled:opacity-50"
                  >
                    {saving ? "…" : "保存"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditId(null)}
                    className="text-[10px] px-1.5 text-[var(--text-muted)] hover:underline"
                  >
                    取消
                  </button>
                </div>
              ) : (
                <>
                  <button
                    type="button"
                    className="w-full text-left"
                    onClick={() => onSelect(it)}
                  >
                    <div className="text-[var(--text-primary)] font-medium truncate">
                      {it.name}
                    </div>
                    <div className="font-num text-[10px] text-[var(--text-muted)] break-all mt-0.5">
                      {it.text}
                    </div>
                  </button>
                  <div className="flex gap-2 mt-1 text-[var(--text-muted)]">
                    {it.symbol && <span>{it.symbol}</span>}
                    {it.composite != null && (
                      <span className="font-num">{it.composite.toFixed(2)}</span>
                    )}
                    <button
                      type="button"
                      className="text-[var(--primary)]/80 hover:underline"
                      onClick={() => startEdit(it)}
                    >
                      改名
                    </button>
                    <button
                      type="button"
                      className="text-red-400/80 hover:underline ml-auto"
                      onClick={() => onDelete(it.id)}
                    >
                      取消收藏
                    </button>
                  </div>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
