"use client"

/**
 * 策略收藏夹 —— 文件夹列（因子/任务收藏共用）
 *
 * 一级菜单：全部 / 未分类 / 各文件夹；支持新建、重命名、删除
 * （删除文件夹时其中收藏自动回到未分类）。
 * 文件夹是 dnd-kit 放置目标：拖动中显示虚线可放置环，
 * 悬停时放大并主题色描边选中，放置成功绿色闪烁（flashId 由面板控制）。
 */

import { useState } from "react"
import { useDroppable } from "@dnd-kit/core"
import { Folder, FolderOpen, Plus, RefreshCw, Trash2 } from "lucide-react"
import { cn } from "@/lib/utils"
import {
  createFolder,
  deleteFolder,
  renameFolder,
  type FolderKind,
  type StrategyFolderItem,
} from "@/lib/strategy-favorites-api"

export type FolderFilter = "all" | "none" | string

/** 未分类的放置目标 ID（面板据此识别"移回未分类"） */
export const NONE_DROP_ID = "folder:__none__"

export function folderDropId(folderId: string): string {
  return `folder:${folderId}`
}

/** 单个放置目标行：悬停放大 + 描边选中 + 放置成功闪烁 */
function DroppableRow({
  dropId,
  dragActive,
  flash,
  children,
}: {
  dropId: string
  dragActive: boolean
  flash: boolean
  children: React.ReactNode
}): React.JSX.Element {
  const { setNodeRef, isOver } = useDroppable({ id: dropId })
  return (
    <div
      ref={setNodeRef}
      className={cn(
        "rounded-md transition-all duration-150",
        dragActive && "ring-1 ring-dashed ring-[var(--primary)]/40",
        isOver &&
          "ring-2 ring-[var(--primary)] bg-[var(--primary)]/15 scale-110 shadow-md",
        flash && "ring-2 ring-emerald-400 bg-emerald-500/10",
      )}
    >
      {children}
    </div>
  )
}

export function FolderColumn({
  kind,
  folders,
  active,
  onSelect,
  onChanged,
  countsOf,
  dragActive = false,
  flashId = null,
}: {
  kind: FolderKind
  folders: StrategyFolderItem[]
  active: FolderFilter
  onSelect: (id: FolderFilter) => void
  onChanged: () => void
  /** 文件夹 → 条目数（用于展示） */
  countsOf: (folderId: string) => number
  /** 有卡片拖动进行中（显示可放置态） */
  dragActive?: boolean
  /** 刚放置成功的文件夹原始 id（绿色闪烁，清除由面板负责） */
  flashId?: string | null
}): React.JSX.Element {
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState("")
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameText, setRenameText] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleCreate(): Promise<void> {
    const name = newName.trim()
    if (!name) return
    setBusy(true)
    setError(null)
    try {
      await createFolder(kind, name)
      setNewName("")
      setCreating(false)
      onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : "创建失败")
    } finally {
      setBusy(false)
    }
  }

  async function handleRename(id: string): Promise<void> {
    const name = renameText.trim()
    if (!name) return
    setBusy(true)
    setError(null)
    try {
      await renameFolder(id, name)
      setRenamingId(null)
      onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : "重命名失败")
    } finally {
      setBusy(false)
    }
  }

  async function handleDelete(id: string): Promise<void> {
    if (!window.confirm("删除文件夹？其中的收藏会回到「未分类」，不会被删除。"))
      return
    setBusy(true)
    setError(null)
    try {
      await deleteFolder(id)
      if (active === id) onSelect("all")
      onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : "删除失败")
    } finally {
      setBusy(false)
    }
  }

  const itemCls = (id: FolderFilter) =>
    cn(
      "w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-xs transition-colors cursor-pointer",
      active === id
        ? "bg-[var(--primary)]/15 text-[var(--primary)]"
        : "text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]",
    )

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-2 py-1.5 border-b border-[var(--border)]">
        <span className="text-xs font-semibold text-[var(--text-primary)]">
          文件夹
        </span>
        <button
          type="button"
          onClick={() => {
            setCreating(true)
            setNewName("")
          }}
          disabled={busy}
          title="新建文件夹"
          className="p-1 rounded text-[var(--text-muted)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)] cursor-pointer disabled:opacity-50"
        >
          <Plus className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-1.5 py-1 space-y-0.5">
        <button type="button" onClick={() => onSelect("all")} className={itemCls("all")}>
          <FolderOpen className="w-3.5 h-3.5 shrink-0" />
          <span className="flex-1 text-left">全部</span>
        </button>

        <DroppableRow dropId={NONE_DROP_ID} dragActive={dragActive} flash={flashId === "__none__"}>
          <button type="button" onClick={() => onSelect("none")} className={itemCls("none")}>
            <Folder className="w-3.5 h-3.5 shrink-0" />
            <span className="flex-1 text-left">未分类</span>
            {dragActive && (
              <span className="text-[9px] text-[var(--primary)] shrink-0">
                拖到这
              </span>
            )}
          </button>
        </DroppableRow>

        {folders.map((f) =>
          renamingId === f.id ? (
            <div key={f.id} className="px-1">
              <input
                autoFocus
                value={renameText}
                onChange={(e) => setRenameText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void handleRename(f.id)
                  if (e.key === "Escape") setRenamingId(null)
                }}
                className="flex-1 w-full h-7 px-2 rounded text-xs bg-[var(--bg-tertiary)] border border-[var(--border)] outline-none focus:border-[var(--primary)]/50"
              />
            </div>
          ) : (
            <DroppableRow
              key={f.id}
              dropId={folderDropId(f.id)}
              dragActive={dragActive}
              flash={flashId === f.id}
            >
              <div
                role="button"
                onClick={() => onSelect(f.id)}
                className={cn(itemCls(f.id), "group")}
              >
                <Folder className="w-3.5 h-3.5 shrink-0" />
                <span className="flex-1 text-left truncate">{f.name}</span>
                <span className="text-[10px] text-[var(--text-muted)] font-num shrink-0">
                  {countsOf(f.id)}
                </span>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    setRenamingId(f.id)
                    setRenameText(f.name)
                  }}
                  title="重命名"
                  className="hidden group-hover:block shrink-0 text-[var(--text-muted)] hover:text-[var(--text-primary)] cursor-pointer"
                >
                  <RefreshCw className="w-3 h-3" />
                </button>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    void handleDelete(f.id)
                  }}
                  title="删除文件夹"
                  className="hidden group-hover:block shrink-0 text-[var(--text-muted)] hover:text-red-400 cursor-pointer"
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              </div>
            </DroppableRow>
          ),
        )}

        {creating && (
          <div className="px-1 pt-1">
            <input
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleCreate()
                if (e.key === "Escape") setCreating(false)
              }}
              placeholder="文件夹名称，如：黑色系因子"
              className="w-full h-7 px-2 rounded text-xs bg-[var(--bg-tertiary)] border border-[var(--border)] outline-none focus:border-[var(--primary)]/50"
            />
            <div className="flex gap-1 pt-1">
              <button
                type="button"
                onClick={() => void handleCreate()}
                disabled={busy || !newName.trim()}
                className="px-2 py-0.5 rounded text-[10px] bg-[var(--primary)] text-white disabled:opacity-50 cursor-pointer"
              >
                保存
              </button>
              <button
                type="button"
                onClick={() => setCreating(false)}
                className="px-2 py-0.5 rounded text-[10px] text-[var(--text-muted)] hover:bg-[var(--bg-tertiary)] cursor-pointer"
              >
                取消
              </button>
            </div>
          </div>
        )}

        {folders.length === 0 && !creating && (
          <p className="text-[10px] text-[var(--text-muted)] text-center py-3 leading-relaxed">
            暂无文件夹
            <br />
            点右上 + 新建，收藏可拖入归类
          </p>
        )}
        {error && (
          <p className="text-[10px] text-red-400 px-1 pt-1 break-all">{error}</p>
        )}
      </div>
    </div>
  )
}
