"use client"

import { useEffect, useState } from "react"
import { Key, Plus, RotateCw, Trash2, Copy, Check } from "lucide-react"
import {
  createApiKeyApi,
  deleteApiKeyApi,
  listApiKeysApi,
  rotateApiKeyApi,
  updateApiKeyApi,
  type ApiKeyItem,
} from "@/lib/admin-api"
import { cn } from "@/lib/utils"

/** API Key 管理页 —— 对外展示站对接凭证 */
export default function AdminApiKeysPage(): React.JSX.Element {
  const [items, setItems] = useState<ApiKeyItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState("")
  const [revealed, setRevealed] = useState<ApiKeyItem | null>(null)
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)

  const load = async () => {
    try {
      setLoading(true)
      const res = await listApiKeysApi()
      setItems(res.items)
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  const handleCreate = async () => {
    const name = newName.trim()
    if (!name) return
    try {
      setBusy("new")
      const item = await createApiKeyApi(name)
      setRevealed(item)
      setNewName("")
      setCreating(false)
      if (item.raw_key) await copyText(item.raw_key)
      await load()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const handleToggle = async (item: ApiKeyItem) => {
    try {
      setBusy(item.id)
      await updateApiKeyApi(item.id, { is_active: !item.is_active })
      await load()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const handleRotate = async (item: ApiKeyItem) => {
    if (!window.confirm(`重置「${item.name}」的 Key？旧 Key 立即失效。`)) return
    try {
      setBusy(item.id)
      const fresh = await rotateApiKeyApi(item.id)
      setRevealed(fresh)
      if (fresh.raw_key) await copyText(fresh.raw_key)
      await load()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const handleDelete = async (item: ApiKeyItem) => {
    if (!window.confirm(`删除「${item.name}」？此操作不可撤销。`)) return
    try {
      setBusy(item.id)
      await deleteApiKeyApi(item.id)
      await load()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const copyText = async (raw: string) => {
    try {
      await navigator.clipboard.writeText(raw)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      /* 剪贴板被拒时降级为手动复制按钮 */
    }
  }

  return (
    <div className="p-4 md:p-6 space-y-4 max-w-4xl">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-lg font-semibold text-[var(--text-primary)] flex items-center gap-2">
            <Key className="w-5 h-5" /> API Keys
          </h1>
          <p className="text-xs text-[var(--text-muted)] mt-1">
            对外展示站对接凭证。调用{" "}
            <code className="text-[var(--text-secondary)]">
              /api/public/ai-trading
            </code>{" "}
            时通过 <code>X-API-Key</code> 头传入。
          </p>
        </div>
        <button
          type="button"
          onClick={() => setCreating((v) => !v)}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-[var(--primary)] text-white text-sm hover:opacity-90"
        >
          <Plus className="w-4 h-4" /> 新建 Key
        </button>
      </div>

      {error && (
        <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-md px-3 py-2">
          {error}
        </div>
      )}

      {creating && (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] p-3 flex items-center gap-2">
          <input
            autoFocus
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleCreate()}
            placeholder="用途/展示站名称，如「收益展示站」"
            className="flex-1 bg-transparent border border-[var(--border)] rounded-md px-3 py-1.5 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--primary)]"
          />
          <button
            type="button"
            onClick={handleCreate}
            disabled={busy === "new" || !newName.trim()}
            className="px-3 py-1.5 rounded-md bg-[var(--primary)] text-white text-sm disabled:opacity-50"
          >
            生成
          </button>
        </div>
      )}

      {revealed && revealed.raw_key && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3">
          <div className="flex items-center justify-between gap-2 mb-2">
            <p className="text-xs text-amber-300 font-medium">
              「{revealed.name}」的 Key 已生成 —— 仅此一次可见，已自动复制到剪贴板，请妥善保存！
            </p>
            <button
              type="button"
              onClick={() => setRevealed(null)}
              className="text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)]"
            >
              关闭
            </button>
          </div>
          <div className="flex items-center gap-2">
            <code className="flex-1 bg-black/30 rounded px-2 py-1.5 text-xs text-amber-200 font-mono break-all">
              {revealed.raw_key}
            </code>
            <button
              type="button"
              onClick={() => revealed.raw_key && copyText(revealed.raw_key)}
              className={cn(
                "px-2 py-1.5 rounded text-xs inline-flex items-center gap-1 shrink-0",
                copied
                  ? "bg-emerald-500/20 text-emerald-300"
                  : "bg-[var(--bg-tertiary)] text-[var(--text-secondary)]",
              )}
            >
              {copied ? (
                <Check className="w-3.5 h-3.5" />
              ) : (
                <Copy className="w-3.5 h-3.5" />
              )}
              {copied ? "已复制" : "复制"}
            </button>
          </div>
        </div>
      )}

      <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] overflow-hidden">
        {loading ? (
          <div className="p-6 text-center text-sm text-[var(--text-muted)]">
            加载中…
          </div>
        ) : items.length === 0 ? (
          <div className="p-6 text-center text-sm text-[var(--text-muted)]">
            还没有 API Key，点击右上角「新建 Key」创建
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-[var(--bg-tertiary)]/50 text-[var(--text-muted)] text-xs">
              <tr>
                <th className="text-left px-3 py-2 font-medium">名称</th>
                <th className="text-left px-3 py-2 font-medium">Key 前缀</th>
                <th className="text-left px-3 py-2 font-medium">状态</th>
                <th className="text-left px-3 py-2 font-medium">最后使用</th>
                <th className="text-right px-3 py-2 font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id} className="border-t border-[var(--border)]">
                  <td className="px-3 py-2 text-[var(--text-primary)]">
                    {item.name}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs text-[var(--text-secondary)]">
                    {item.key_preview}
                  </td>
                  <td className="px-3 py-2">
                    <span
                      className={cn(
                        "inline-block text-[10px] px-1.5 py-0.5 rounded",
                        item.is_active
                          ? "bg-emerald-500/15 text-emerald-400"
                          : "bg-zinc-500/15 text-zinc-400",
                      )}
                    >
                      {item.is_active ? "启用" : "已停用"}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-xs text-[var(--text-muted)]">
                    {item.last_used_at
                      ? new Date(item.last_used_at).toLocaleString("zh-CN")
                      : "—"}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex items-center justify-end gap-1">
                      <button
                        type="button"
                        onClick={() => handleToggle(item)}
                        disabled={busy === item.id}
                        className="text-xs px-2 py-1 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] disabled:opacity-50"
                      >
                        {item.is_active ? "停用" : "启用"}
                      </button>
                      <button
                        type="button"
                        onClick={() => handleRotate(item)}
                        disabled={busy === item.id}
                        title="重置 Key（旧 Key 立即失效）"
                        className="p-1.5 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] disabled:opacity-50"
                      >
                        <RotateCw className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDelete(item)}
                        disabled={busy === item.id}
                        title="删除"
                        className="p-1.5 rounded hover:bg-red-500/15 text-red-400 disabled:opacity-50"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
