"use client"

/** 短线因子收藏面板(桌面)—— 桌面短线实验室冠军的独立收藏
 *
 * 与因子收藏严格分流:短线 token 是桌面编码,服务端因子收藏消费
 * v3 编码(83 行特征表),两套表 52 号后同号不同义,混存必被误读。
 */

import { FavoriteFilterBar } from "./favorite-filter-bar"
import { EMPTY_FAVORITE_FILTERS, matchesFavoriteFilters, favoriteAnnualPercent } from "@/lib/favorite-filters"
import { DndContext, useDraggable, type DragEndEvent } from "@dnd-kit/core"
import { FolderColumn, NONE_DROP_ID, type FolderFilter } from "./folder-column"
import { listFolders, type StrategyFolderItem } from "@/lib/strategy-favorites-api"
import { EvolutionButton } from "@/components/factor-lab/evolution/evolution-button"
import { EvolutionEvidence } from "@/components/factor-lab/evolution/evolution-evidence"
import { useEffect, useState } from "react"
import { FavoriteTransferToolbar, StrategyExportButton } from "./transfer-controls"
import {
  moveShortlineFavorite,
  deleteShortlineFavorite,
  listShortlineFavorites,
  type ShortlineFavoriteItem,
} from "@/lib/shortline/server-api"

export function ShortlineFavoritesPanel() {
  const [filters, setFilters] = useState({...EMPTY_FAVORITE_FILTERS})
  const [folders, setFolders] = useState<StrategyFolderItem[]>([])
  const [active, setActive] = useState<FolderFilter>("all")
  const [dragging, setDragging] = useState(false)
  const [items, setItems] = useState<ShortlineFavoriteItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [copiedId, setCopiedId] = useState<string | null>(null)

  async function refresh() {
    setLoading(true)
    setError(null)
    try {
      const [items, folders] = await Promise.all([listShortlineFavorites(), listFolders("shortline")])
      setItems(items); setFolders(folders)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void refresh() }, [])
  useEffect(() => { const update = () => void refresh(); window.addEventListener("strategy-favorites-changed", update); return () => window.removeEventListener("strategy-favorites-changed", update) }, [])

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
    void navigator.clipboard?.writeText(Array.isArray(item.tokens[0]) ? JSON.stringify({groups: item.tokens, weights: (item.metrics?.evolution_recipe as {weights?: number[]} | undefined)?.weights}) : item.tokens.join(","))
    setCopiedId(item.id)
    setTimeout(() => setCopiedId(null), 1500)
  }

  const filtered = items.filter(f => (active === "all" || (active === "none" ? !f.folder_id : f.folder_id === active))
    && matchesFavoriteFilters(f.timeframe, favoriteAnnualPercent(f.metrics), filters))
  async function move(id: string, folderId: string | null) {
    setBusyId(id)
    try {await moveShortlineFavorite(id, folderId); await refresh()}
    catch (e) {setError(e instanceof Error ? e.message : String(e))}
    finally {setBusyId(null)}
  }
  function onDragEnd(e: DragEndEvent) {
    setDragging(false)
    const target = String(e.over?.id ?? "")
    if (!target.startsWith("folder:")) return
    void move(String(e.active.id), target === NONE_DROP_ID ? null : target.slice(7))
  }
  return (
    <DndContext onDragStart={() => setDragging(true)} onDragEnd={onDragEnd} onDragCancel={() => setDragging(false)}>
    <div className="flex h-full min-h-0">
    <div className="w-[200px] shrink-0 border-r border-[var(--border)] bg-[var(--bg-secondary)]">
      <FolderColumn kind="shortline" folders={folders} active={active} onSelect={setActive} onChanged={() => void refresh()} countsOf={id => items.filter(f => f.folder_id === id).length} dragActive={dragging}/>
    </div>
    <div className="flex-1 min-w-0 overflow-auto p-3 space-y-2">
      <FavoriteTransferToolbar kind="shortline" />
      <FavoriteFilterBar value={filters} onChange={setFilters} />
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
      ) : filtered.length === 0 ? (
        <div className="text-xs text-[var(--text-muted)] p-4">
          暂无短线因子收藏。到「短线因子实验室」挖掘完成后，在冠军卡片上点「收藏」。
        </div>
      ) : (
        <div className="space-y-1.5">
          {filtered.map((f) => (
            <ShortlineDraggable
              id={f.id} key={f.id}
              className="rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] p-2.5 space-y-1"
            >
              <div className="flex items-center gap-2 text-[10px] text-[var(--text-muted)]">
                <select aria-label={`分类 ${f.name}`} disabled={busyId === f.id} value={f.folder_id ?? ""} className="rounded border border-[var(--border)] bg-[var(--bg-secondary)] px-1 py-1" onChange={e => void move(f.id, e.target.value || null)}>
                  <option value="">未分类</option>{folders.map(folder => <option key={folder.id} value={folder.id}>{folder.name}</option>)}
                </select>
                <span>年化 {favoriteAnnualPercent(f.metrics) === null ? "—" : `${favoriteAnnualPercent(f.metrics)!.toFixed(2)}%`}</span>
              </div>
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
                  <EvolutionButton source={{kind: "shortline_favorite", id: f.id}} />
                  <StrategyExportButton kind="shortline" favoriteId={f.id} />
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
              {!!f.metrics?.evolution_recipe && <details className="text-xs"><summary className="cursor-pointer text-[var(--primary)]">进化验证数据与组合权重</summary><div className="pt-2"><EvolutionEvidence metrics={f.metrics} /></div></details>}
            </ShortlineDraggable>
          ))}
        </div>
      )}
    </div></div></DndContext>
  )
}

function ShortlineDraggable({id, children, className}: {id: string; children: React.ReactNode; className?: string}) {
  const {setNodeRef, attributes, listeners, transform, isDragging} = useDraggable({id})
  return <div ref={setNodeRef} className={className} style={{opacity: isDragging ? .5 : 1, transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined}}>
    <button type="button" {...attributes} {...listeners} className="text-[10px] text-[var(--text-muted)] cursor-grab touch-none" aria-label="拖动到分类文件夹">⠿ 拖动分类</button>
    {children}
  </div>
}
