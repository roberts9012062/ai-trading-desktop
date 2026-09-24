"use client"

/**
 * 任务收藏弹窗 —— 从任务卡片星标唤起，选一级文件夹（可就地新建）保存
 * 重复收藏 = 移动到所选文件夹并刷新快照。
 */

import { useEffect, useState } from "react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  addTaskFavorite,
  createFolder,
  listFolders,
  type StrategyFolderItem,
} from "@/lib/strategy-favorites-api"

const NEW_FOLDER = "__new__"

export function TaskFavoriteDialog({
  task,
  currentFolderId,
  onClose,
  onSaved,
}: {
  task: { id: string; name: string } | null
  /** 已收藏时的当前文件夹（用于默认选中） */
  currentFolderId?: string | null
  onClose: () => void
  onSaved: () => void
}): React.JSX.Element {
  const [folders, setFolders] = useState<StrategyFolderItem[]>([])
  const [folderId, setFolderId] = useState("")
  const [newFolderName, setNewFolderName] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!task) return
    setFolderId(currentFolderId ?? "")
    setNewFolderName("")
    setError(null)
    void listFolders("task")
      .then(setFolders)
      .catch(() => setFolders([]))
  }, [task, currentFolderId])

  async function handleSave(): Promise<void> {
    if (!task) return
    setSubmitting(true)
    setError(null)
    try {
      let targetFolder: string | null = folderId || null
      if (folderId === NEW_FOLDER) {
        const fname = newFolderName.trim()
        if (!fname) {
          setError("请输入新文件夹名称")
          setSubmitting(false)
          return
        }
        try {
          const f = await createFolder("task", fname)
          targetFolder = f.id
        } catch (e) {
          setError(e instanceof Error ? e.message : "新建文件夹失败")
          setSubmitting(false)
          return
        }
      }
      await addTaskFavorite(task.id, targetFolder)
      onSaved()
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : "收藏失败")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={Boolean(task)} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>收藏任务到策略收藏夹</DialogTitle>
        </DialogHeader>
        <p className="text-[11px] text-[var(--text-muted)] -mt-1 truncate">
          {task?.name}
        </p>
        <div className="space-y-3 text-sm">
          <div className="space-y-1">
            <label className="text-xs text-[var(--text-muted)]">
              归类文件夹（一级菜单）
            </label>
            <select
              value={folderId}
              onChange={(e) => setFolderId(e.target.value)}
              className="w-full h-8 px-2 text-xs bg-[var(--bg-tertiary)] border border-[var(--border)] rounded outline-none focus:border-[var(--primary)]/50"
            >
              <option value="">未分类</option>
              {folders.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
              <option value={NEW_FOLDER}>＋ 新建文件夹…</option>
            </select>
            {folderId === NEW_FOLDER && (
              <Input
                autoFocus
                value={newFolderName}
                onChange={(e) => setNewFolderName(e.target.value)}
                placeholder="文件夹名称，如：趋势策略"
                className="h-8 text-xs"
              />
            )}
          </div>
          {error && <p className="text-[11px] text-red-400">{error}</p>}
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="ghost" size="sm" onClick={onClose} className="text-xs">
              取消
            </Button>
            <Button
              size="sm"
              onClick={() => void handleSave()}
              disabled={submitting}
              className="text-xs"
            >
              {submitting ? "保存中…" : "保存"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
