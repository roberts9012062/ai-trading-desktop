"use client"

/**
 * 因子收藏夹 —— 左文件夹 / 右因子收藏卡片
 *
 * dnd-kit 拖拽：卡片在网格内拖动实时补位（FLIP 过渡动画）、
 * 松手持久化顺序；拖到左侧文件夹（悬停放大描边）归类。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core"
import {
  SortableContext,
  arrayMove,
  rectSortingStrategy,
} from "@dnd-kit/sortable"
import { Trash2 } from "lucide-react"
import { cn } from "@/lib/utils"
import {
  listFactorFavorites,
  patchFactorFavorite,
  deleteFactorFavorite,
  reorderFactorFavorites,
  type FactorFavoriteItem,
} from "@/lib/factor-lab-api"
import {
  listFolders,
  type StrategyFolderItem,
} from "@/lib/strategy-favorites-api"
import {
  FolderColumn,
  NONE_DROP_ID,
  type FolderFilter,
} from "@/components/strategy-favorites/folder-column"
import { SortableCard } from "@/components/strategy-favorites/sortable-card"

/** 卡片内容（排序位与 DragOverlay 共用） */
function FactorCardView({
  f,
  folderName,
  onDelete,
}: {
  f: FactorFavoriteItem
  folderName: string
  onDelete: () => void
}): React.JSX.Element {
  const annRet = Number(f.metrics?.ann_ret ?? 0)
  const annPct = Number.isFinite(annRet) ? (annRet * 100).toFixed(1) : "0.0"
  const sortino = f.metrics?.sortino
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] p-3 h-full flex flex-col">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs font-medium text-[var(--text-primary)] truncate">
            {f.name}
          </p>
          <p className="text-[10px] text-[var(--text-muted)] font-num pt-0.5">
            {f.symbol || "—"} · {f.timeframe || "—"} · {folderName}
          </p>
        </div>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onDelete()
          }}
          title="删除收藏"
          className="shrink-0 p-1 rounded text-[var(--text-muted)] hover:text-red-400 cursor-pointer"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>
      <div className="flex items-center gap-3 pt-2 text-[10px] font-num">
        <span className="text-[var(--text-muted)]">
          年化{" "}
          <span className={Number(annRet) > 0 ? "text-up" : "text-down"}>
            {annPct}%
          </span>
        </span>
        {sortino != null && (
          <span className="text-[var(--text-muted)]">
            Sortino{" "}
            <span className="text-[var(--text-secondary)]">
              {Number(sortino).toFixed(2)}
            </span>
          </span>
        )}
      </div>
    </div>
  )
}

export function FactorFavoritesPanel(): React.JSX.Element {
  const [folders, setFolders] = useState<StrategyFolderItem[]>([])
  const [items, setItems] = useState<FactorFavoriteItem[]>([])
  const [active, setActive] = useState<FolderFilter>("all")
  const [loading, setLoading] = useState(true)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [flashFolder, setFlashFolder] = useState<string | null>(null)
  const flashTimer = useRef(0)

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  )

  const reload = useCallback(async () => {
    setLoading(true)
    try {
      const [f, items] = await Promise.all([
        listFolders("factor"),
        listFactorFavorites(),
      ])
      setFolders(f)
      setItems(items)
    } catch {
      // 保持旧数据
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  useEffect(() => () => window.clearTimeout(flashTimer.current), [])

  function flashFolderDrop(dropId: string): void {
    const id = dropId === NONE_DROP_ID ? "__none__" : dropId.slice("folder:".length)
    setFlashFolder(id)
    window.clearTimeout(flashTimer.current)
    flashTimer.current = window.setTimeout(() => setFlashFolder(null), 900)
  }

  const filtered = useMemo(() => {
    if (active === "all") return items
    if (active === "none") return items.filter((x) => !x.folder_id)
    return items.filter((x) => x.folder_id === active)
  }, [items, active])

  const countsOf = useCallback(
    (folderId: string) =>
      items.filter((x) => x.folder_id === folderId).length,
    [items],
  )

  const folderNameOf = useCallback(
    (folderId?: string | null) =>
      folderId
        ? (folders.find((x) => x.id === folderId)?.name ?? "")
        : "未分类",
    [folders],
  )

  async function handleDelete(id: string): Promise<void> {
    if (!window.confirm("删除该因子收藏？")) return
    try {
      await deleteFactorFavorite(id)
      await reload()
    } catch {
      // ignore
    }
  }

  function onDragStart(e: DragStartEvent): void {
    setActiveId(String(e.active.id))
  }

  function onDragEnd(e: DragEndEvent): void {
    const { active: a, over } = e
    setActiveId(null)
    if (!over) return
    const overId = String(over.id)

    // 放到文件夹：归类（未分类放置目标 = 移回未分类，显式空串）
    if (overId.startsWith("folder:")) {
      const folderId =
        overId === NONE_DROP_ID ? "" : overId.slice("folder:".length)
      flashFolderDrop(overId)
      void patchFactorFavorite(String(a.id), { folder_id: folderId })
        .then(() => reload())
        .catch(() => undefined)
      return
    }

    // 放到另一张卡片：整体重排（在完整列表上换算，过滤视图同样正确）
    if (overId !== String(a.id)) {
      setItems((prev) => {
        const from = prev.findIndex((x) => x.id === a.id)
        const to = prev.findIndex((x) => x.id === overId)
        if (from < 0 || to < 0) return prev
        const next = arrayMove(prev, from, to)
        void reorderFactorFavorites(next.map((x) => x.id)).catch(
          () => undefined,
        )
        return next
      })
    }
  }

  const activeItem = activeId
    ? items.find((x) => x.id === activeId) ?? null
    : null

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragCancel={() => setActiveId(null)}
    >
      <div className="flex h-full min-h-0">
        <div className="w-[200px] shrink-0 border-r border-[var(--border)] bg-[var(--bg-secondary)]">
          <FolderColumn
            kind="factor"
            folders={folders}
            active={active}
            onSelect={setActive}
            onChanged={() => void reload()}
            countsOf={countsOf}
            dragActive={Boolean(activeId)}
            flashId={flashFolder}
          />
        </div>

        <div className="flex-1 min-w-0 overflow-y-auto p-3">
          {loading && items.length === 0 && (
            <p className="text-xs text-[var(--text-muted)] text-center py-10">
              加载中…
            </p>
          )}
          {!loading && filtered.length === 0 && (
            <p className="text-xs text-[var(--text-muted)] text-center py-10">
              暂无因子收藏。去「因子实验室」挖掘后点收藏（可选文件夹归类）。
            </p>
          )}
          <SortableContext
            items={filtered.map((x) => x.id)}
            strategy={rectSortingStrategy}
          >
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2">
              {filtered.map((f) => (
                <SortableCard key={f.id} id={f.id} className="h-full">
                  <FactorCardView
                    f={f}
                    folderName={folderNameOf(f.folder_id)}
                    onDelete={() => void handleDelete(f.id)}
                  />
                </SortableCard>
              ))}
            </div>
          </SortableContext>
        </div>
      </div>

      {/* 跟随鼠标的悬浮卡片 */}
      <DragOverlay
        dropAnimation={{ duration: 180, easing: "cubic-bezier(0.2, 0, 0, 1)" }}
      >
        {activeItem ? (
          <div className="w-[300px] rotate-2 scale-105 shadow-2xl rounded-lg cursor-grabbing">
            <FactorCardView
              f={activeItem}
              folderName={folderNameOf(activeItem.folder_id)}
              onDelete={() => undefined}
            />
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  )
}
