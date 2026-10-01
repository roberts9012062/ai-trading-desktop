"use client"

/** 短线因子收藏面板(桌面)—— 桌面短线实验室冠军的独立收藏
 *
 * 与因子收藏严格分流:短线 token 是桌面编码,服务端因子收藏消费
 * v3 编码(83 行特征表),两套表 52 号后同号不同义,混存必被误读。
 */

import { useEffect, useState } from "react"
import {
  deleteShortlineFavorite,
  listShortlineFavorites,
  type ShortlineFavoriteItem,
} from "@/lib/shortline/server-api"

export function ShortlineFavoritesPanel() {
  const [items, setItems] = useState<ShortlineFavoriteItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [copiedId, setCopiedId] = useState<string | null>(null)

  async function refresh() {
    setLoading(true)
    setError(null)
    try {
      setItems(await listShortlineFavorites())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void refresh() }, [])

  async function onDelete(id: string) {
    setBusyId(id)
    try {
      await deleteShortlineFavorite(id)
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusyId(null)
    }
  }

  function onCopy(item: ShortlineFavoriteItem) {
    void navigator.clipboard?.writeText(item.tokens.join(","))
    setCopiedId(item.id)
    setTimeout(() => setCopiedId(null), 1500)
  }

  return (
    <div className="h-full overflow-auto p-3 space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-[11px] text-[var(--text-muted)]">
          短线因子收藏（短线实验室冠军；创建服务器任务请到 AI 交易 → 量化 → 短线因子）
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          className="text-[11px] px-2 h-7 rounded-md border border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] cursor-pointer"
        >
          刷新
        </button>
      </div>

      {loading ? (
        <div className="text-xs text-[var(--text-muted)] p-4">加载中…</div>
      ) : error ? (
        <div className="text-xs text-red-500 p-2 rounded-md border border-red-500/30">{error}</div>
      ) : items.length === 0 ? (
        <div className="text-xs text-[var(--text-muted)] p-4">
          暂无短线因子收藏。到「短线因子实验室」挖掘完成后，在冠军卡片上点「收藏」。
        </div>
      ) : (
        <div className="space-y-1.5">
          {items.map((f) => (
            <div
              key={f.id}
              className="rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] p-2.5 space-y-1"
            >
              <div className="flex items-center justify-between gap-2">
                <div className="text-xs font-medium text-[var(--text-primary)] truncate">
                  {f.name}
                  <span className="text-[var(--text-muted)] font-normal">
                    {" "}· {f.symbol}
                    {f.timeframe ? ` · ${f.timeframe}` : ""}
                    {f.composite != null ? ` · ${f.composite.toFixed(3)}` : ""}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => onCopy(f)}
                    className="text-[11px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] cursor-pointer"
                  >
                    {copiedId === f.id ? "已复制" : "复制 tokens"}
                  </button>
                  <button
                    type="button"
                    disabled={busyId === f.id}
                    onClick={() => void onDelete(f.id)}
                    className="text-[11px] text-red-400 hover:text-red-300 disabled:opacity-50 cursor-pointer"
                  >
                    {busyId === f.id ? "删除中…" : "删除"}
                  </button>
                </div>
              </div>
              <div className="text-[11px] font-mono text-[var(--text-secondary)] break-all">
                {f.text || f.tokens.join(" ")}
              </div>
              {f.note ? <div className="text-[10px] text-[var(--text-muted)]">{f.note}</div> : null}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
