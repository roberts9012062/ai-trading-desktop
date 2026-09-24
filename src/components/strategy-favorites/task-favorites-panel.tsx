"use client"

/**
 * AI 任务收藏夹 —— 左文件夹 / 右收藏任务卡片
 *
 * 卡片：详情（运行历史/决策/信息抽屉）、修改参数（运行中禁用）、
 * 克隆（预填创建表单可改参数）、取消收藏。
 * dnd-kit 拖拽：网格内实时补位排序（松手持久化）、拖到文件夹归类。
 * 任务被删除后按快照只读展示（详情/修改不可用，克隆仍可用）。
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
import { Copy, Pencil, Trash2 } from "lucide-react"
import { cn } from "@/lib/utils"
import {
  listAITradingDecisions,
  listAITradingTrades,
  type AITradingDecision,
  type AITradingTask,
} from "@/lib/ai-trading-api"
import { QUANT_KIND_OPTIONS } from "@/lib/quant-strategy"
import {
  deleteTaskFavorite,
  listFolders,
  listTaskFavorites,
  moveTaskFavorite,
  reorderTaskFavorites,
  type StrategyFolderItem,
  type TaskFavoriteItem,
} from "@/lib/strategy-favorites-api"
import {
  FolderColumn,
  NONE_DROP_ID,
  type FolderFilter,
} from "@/components/strategy-favorites/folder-column"
import { SortableCard } from "@/components/strategy-favorites/sortable-card"
import { TaskIcon } from "@/components/ai-trading/task-icon"
import { TaskDetailDrawer } from "@/components/ai-trading/detail/task-detail-drawer"
import { EditTaskDialog } from "@/components/ai-trading/form/edit-task-dialog"
import { CreateTaskDialog } from "@/components/ai-trading/form/create-task-dialog"
import { CreateQuantDialog } from "@/components/ai-trading/form/create-quant-dialog"

const QUANT_STRATEGY_SET = new Set<string>(
  QUANT_KIND_OPTIONS.map((o) => o.value),
)

function isQuantType(strategyType: string | null | undefined): boolean {
  return QUANT_STRATEGY_SET.has(String(strategyType || "").toLowerCase())
}

/** 收藏（快照或活任务）→ 可展示/可预填的任务形态 */
function asTask(fav: TaskFavoriteItem): AITradingTask | null {
  if (fav.task) return fav.task as unknown as AITradingTask
  if (!fav.snapshot) return null
  return fav.snapshot as unknown as AITradingTask
}

/** 卡片内容（排序位与 DragOverlay 共用） */
function TaskCardView({
  fav,
  folderName,
  live,
  onDetail,
  onEdit,
  onClone,
  onUnfavorite,
}: {
  fav: TaskFavoriteItem
  folderName: string
  live: boolean
  onDetail: () => void
  onEdit: (editable: boolean) => void
  onClone: (enabled: boolean) => void
  onUnfavorite: () => void
}): React.JSX.Element {
  const task = asTask(fav)
  const running = live && task?.status === "running"
  const editable = live && !running && task?.can_edit !== false
  const strategyType = String(task?.strategy_type ?? "ai")
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] p-3 h-full flex flex-col min-h-[128px]">
      <div className="flex items-start gap-2">
        <TaskIcon
          icon={task?.icon ?? null}
          strategyType={strategyType}
          modelId={task?.model_id ?? null}
          providerName={task?.provider_name ?? null}
          displayName={task?.model_display_name ?? null}
          size={30}
        />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium text-[var(--text-primary)] truncate">
            {task?.name ?? fav.snapshot.name ?? "已删除任务"}
          </p>
          <p className="text-[10px] text-[var(--text-muted)] font-num pt-0.5 truncate">
            {task?.symbol ?? fav.snapshot.symbol ?? "—"} ·{" "}
            {task?.timeframe ?? fav.snapshot.timeframe ?? "—"} · {folderName}
            {!live && " · 任务已删除"}
          </p>
        </div>
        <span
          className={cn(
            "shrink-0 text-[10px] px-1.5 py-0.5 rounded",
            running
              ? "bg-emerald-500/15 text-emerald-400"
              : live
                ? "bg-zinc-500/15 text-zinc-400"
                : "bg-amber-500/15 text-amber-300",
          )}
        >
          {live ? (task?.status ?? "未知") : "快照"}
        </span>
      </div>

      <div className="mt-auto flex items-center gap-1.5 pt-3 flex-wrap">
        <button
          type="button"
          disabled={!live}
          onClick={(e) => {
            e.stopPropagation()
            onDetail()
          }}
          className="text-[10px] px-2 py-1 rounded border border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
          title={live ? undefined : "任务已删除，无法查看运行历史"}
        >
          详情
        </button>
        <button
          type="button"
          disabled={!editable}
          onClick={(e) => {
            e.stopPropagation()
            onEdit(editable)
          }}
          title={
            running
              ? "运行中的任务不能修改参数"
              : !live
                ? "任务已删除"
                : task?.can_edit === false
                  ? "仅已结束且无持仓/未下单的任务可修改"
                  : undefined
          }
          className="text-[10px] px-2 py-1 rounded border border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer inline-flex items-center gap-1"
        >
          <Pencil className="w-3 h-3" />
          修改
        </button>
        <button
          type="button"
          disabled={!task}
          onClick={(e) => {
            e.stopPropagation()
            onClone(Boolean(task))
          }}
          className="text-[10px] px-2 py-1 rounded border border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer inline-flex items-center gap-1"
          title="克隆任务（可修改参数）"
        >
          <Copy className="w-3 h-3" />
          克隆
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onUnfavorite()
          }}
          className="ml-auto p-1 rounded text-[var(--text-muted)] hover:text-red-400 cursor-pointer"
          title="取消收藏"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  )
}

export function TaskFavoritesPanel(): React.JSX.Element {
  const [folders, setFolders] = useState<StrategyFolderItem[]>([])
  const [items, setItems] = useState<TaskFavoriteItem[]>([])
  const [active, setActive] = useState<FolderFilter>("all")
  const [loading, setLoading] = useState(true)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [flashFolder, setFlashFolder] = useState<string | null>(null)
  const flashTimer = useRef(0)

  // 详情抽屉
  const [detailFav, setDetailFav] = useState<TaskFavoriteItem | null>(null)
  const [decisions, setDecisions] = useState<AITradingDecision[]>([])
  const [trades, setTrades] = useState<Record<string, unknown>[]>([])
  const [detailLoading, setDetailLoading] = useState(false)
  // 修改 / 克隆
  const [editTask, setEditTask] = useState<AITradingTask | null>(null)
  const [cloneSource, setCloneSource] = useState<AITradingTask | null>(null)

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  )

  const reload = useCallback(async () => {
    setLoading(true)
    try {
      const [f, items] = await Promise.all([
        listFolders("task"),
        listTaskFavorites(),
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

  // 打开详情时拉取该任务的分析与交易记录
  useEffect(() => {
    if (!detailFav?.task_id) {
      setDecisions([])
      setTrades([])
      return
    }
    const taskId = detailFav.task_id
    setDetailLoading(true)
    void Promise.all([
      listAITradingDecisions(taskId, 50, 0),
      listAITradingTrades(taskId, 50, 0),
    ])
      .then(([d, t]) => {
        setDecisions(d.items ?? [])
        setTrades(t.items ?? [])
      })
      .catch(() => {
        setDecisions([])
        setTrades([])
      })
      .finally(() => setDetailLoading(false))
  }, [detailFav])

  function flashFolderDrop(dropId: string): void {
    const id =
      dropId === NONE_DROP_ID ? "__none__" : dropId.slice("folder:".length)
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

  async function handleUnfavorite(fav: TaskFavoriteItem): Promise<void> {
    if (!window.confirm("取消收藏该任务？")) return
    try {
      await deleteTaskFavorite(fav.id)
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

    if (overId.startsWith("folder:")) {
      const folderId =
        overId === NONE_DROP_ID ? "" : overId.slice("folder:".length)
      flashFolderDrop(overId)
      void moveTaskFavorite(String(a.id), folderId || null)
        .then(() => reload())
        .catch(() => undefined)
      return
    }

    if (overId !== String(a.id)) {
      setItems((prev) => {
        const from = prev.findIndex((x) => x.id === a.id)
        const to = prev.findIndex((x) => x.id === overId)
        if (from < 0 || to < 0) return prev
        const next = arrayMove(prev, from, to)
        void reorderTaskFavorites(next.map((x) => x.id)).catch(() => undefined)
        return next
      })
    }
  }

  const activeItem = activeId
    ? items.find((x) => x.id === activeId) ?? null
    : null
  const cloneQuant = cloneSource
    ? isQuantType(cloneSource.strategy_type)
    : false

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
            kind="task"
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
              暂无任务收藏。在「AI 交易」页任务卡片上点 ⭐ 收藏跑得好的任务。
            </p>
          )}
          <SortableContext
            items={filtered.map((x) => x.id)}
            strategy={rectSortingStrategy}
          >
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2">
              {filtered.map((fav) => {
                const live = Boolean(fav.task_id && fav.task)
                const task = asTask(fav)
                return (
                  <SortableCard key={fav.id} id={fav.id} className="h-full">
                    <TaskCardView
                      fav={fav}
                      folderName={folderNameOf(fav.folder_id)}
                      live={live}
                      onDetail={() => setDetailFav(fav)}
                      onEdit={(editable) => {
                        if (editable && live && task) setEditTask(task)
                      }}
                      onClone={(enabled) => {
                        if (enabled && task) setCloneSource(task)
                      }}
                      onUnfavorite={() => void handleUnfavorite(fav)}
                    />
                  </SortableCard>
                )
              })}
            </div>
          </SortableContext>
        </div>
      </div>

      <DragOverlay
        dropAnimation={{ duration: 180, easing: "cubic-bezier(0.2, 0, 0, 1)" }}
      >
        {activeItem ? (
          <div className="w-[300px] rotate-2 scale-105 shadow-2xl rounded-lg cursor-grabbing">
            <TaskCardView
              fav={activeItem}
              folderName={folderNameOf(activeItem.folder_id)}
              live={Boolean(activeItem.task_id && activeItem.task)}
              onDetail={() => undefined}
              onEdit={() => undefined}
              onClone={() => undefined}
              onUnfavorite={() => undefined}
            />
          </div>
        ) : null}
      </DragOverlay>

      {/* 详情：分析记录 / 交易记录 / 运行日志 / 模型接手 */}
      <TaskDetailDrawer
        open={Boolean(detailFav)}
        task={detailFav ? asTask(detailFav) : null}
        decisions={decisions}
        trades={trades}
        loading={detailLoading}
        onClose={() => setDetailFav(null)}
        readOnly
      />

      <EditTaskDialog
        open={Boolean(editTask)}
        task={editTask}
        onClose={() => setEditTask(null)}
      />

      {/* 克隆：AI 任务 / 量化·因子任务分别预填对应创建表单 */}
      <CreateTaskDialog
        open={Boolean(cloneSource) && !cloneQuant}
        prefillFrom={cloneQuant ? null : cloneSource}
        onClose={() => setCloneSource(null)}
      />
      <CreateQuantDialog
        open={Boolean(cloneSource) && cloneQuant}
        prefillFrom={cloneQuant ? cloneSource : null}
        onClose={() => setCloneSource(null)}
      />
    </DndContext>
  )
}
