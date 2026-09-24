"use client"

/**
 * 因子收藏保存弹窗 —— 选一级文件夹（可就地新建）+ 命名，保存即归类
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
  createFolder,
  listFolders,
  type StrategyFolderItem,
} from "@/lib/strategy-favorites-api"
import type { FavoriteInput } from "@/components/factor-lab/hooks/use-factor-lab-page"

const NEW_FOLDER = "__new__"

export function FactorFavoriteSaveDialog({
  item,
  defaultName,
  onClose,
  onSave,
}: {
  item: FavoriteInput | null
  defaultName: string
  onClose: () => void
  onSave: (
    item: FavoriteInput,
    opts: { name: string; folderId: string | null },
  ) => Promise<void>
}): React.JSX.Element {
  const [folders, setFolders] = useState<StrategyFolderItem[]>([])
  const [name, setName] = useState("")
  const [folderId, setFolderId] = useState("")
  const [newFolderName, setNewFolderName] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!item) return
    setName(defaultName)
    setFolderId("")
    setNewFolderName("")
    setError(null)
    void listFolders("factor")
      .then(setFolders)
      .catch(() => setFolders([]))
  }, [item, defaultName])

  async function handleSave(): Promise<void> {
    if (!item) return
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
          const f = await createFolder("factor", fname)
          targetFolder = f.id
        } catch (e) {
          setError(e instanceof Error ? e.message : "新建文件夹失败")
          setSubmitting(false)
          return
        }
      }
      await onSave(item, { name: name.trim() || defaultName, folderId: targetFolder })
      onClose()
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={Boolean(item)} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>收藏因子</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          <div className="space-y-1">
            <label className="text-xs text-[var(--text-muted)]">名称</label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="收藏名称"
              className="h-8 text-xs"
            />
          </div>
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
                placeholder="文件夹名称，如：黑色系因子"
                className="h-8 text-xs"
              />
            )}
          </div>
          {error && <p className="text-[11px] text-red-400">{error}</p>}
          <div className="flex justify-end gap-2 pt-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={onClose}
              className="text-xs"
            >
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
