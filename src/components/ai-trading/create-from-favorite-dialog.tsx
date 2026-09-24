"use client"

/**
 * 创建优秀任务 —— 从任务收藏夹一键创建
 *
 * 已有相同配置的任务在跑时置灰不可创建
 * （比对 symbol+周期+策略类型+模型+策略参数）。
 */

import { useEffect, useMemo, useState } from "react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import type { AITradingTask, CreateTaskPayload } from "@/lib/ai-trading-api"
import { useAITradingStore } from "@/stores/ai-trading"
import {
  listTaskFavorites,
  type TaskFavoriteItem,
} from "@/lib/strategy-favorites-api"
import { TaskIcon } from "@/components/ai-trading/task-icon"
import { cn } from "@/lib/utils"

/** 相同任务判定键：品种+周期+策略类型+模型+策略参数 */
function configKey(t: {
  symbol?: string | null
  timeframe?: string | null
  strategy_type?: string | null
  model_row_id?: string | null
  strategy_params?: unknown
}): string {
  return [
    String(t.symbol ?? "").toLowerCase(),
    t.timeframe ?? "",
    String(t.strategy_type ?? "ai").toLowerCase(),
    t.model_row_id ?? "",
    JSON.stringify(t.strategy_params ?? {}),
  ].join("|")
}

/** 收藏快照 → 创建任务入参 */
function payloadFromSnapshot(
  fav: TaskFavoriteItem,
  existNames: Set<string>,
): CreateTaskPayload {
  const s = fav.snapshot
  let name = s.name || "优秀任务"
  if (existNames.has(name)) name = `${name}-${Date.now().toString().slice(-4)}`
  return {
    name,
    model_row_id: s.model_row_id ?? null,
    strategy_type: s.strategy_type ?? "ai",
    strategy_params: s.strategy_params ?? {},
    icon: s.icon ?? null,
    symbol: String(s.symbol ?? "").toLowerCase(),
    symbol_name: s.symbol_name ?? s.symbol ?? "",
    timeframe: s.timeframe ?? "15m",
    side_mode: s.side_mode ?? "both",
    position_mode: s.position_mode ?? "fixed_qty",
    fixed_qty: s.fixed_qty ?? 1,
    qty_min: s.qty_min,
    qty_max: s.qty_max,
    allocated_capital: s.allocated_capital ?? 100000,
    capital_usage_min_pct: s.capital_usage_min_pct ?? 0,
    capital_usage_max_pct: s.capital_usage_max_pct ?? 100,
    risk_style: s.risk_style ?? "balanced",
    max_hold_days: s.max_hold_days ?? null,
    custom_prompt_enabled: Boolean(s.custom_prompt_enabled),
    custom_prompt: s.custom_prompt ?? null,
    close_rules: (s.close_rules ?? {}) as unknown as CreateTaskPayload["close_rules"],
    stop_rules: (s.stop_rules ?? {}) as unknown as CreateTaskPayload["stop_rules"],
    close_on_stop: s.close_on_stop !== false,
    auto_start: true,
  }
}

export function CreateFromFavoriteDialog({
  open,
  onClose,
}: {
  open: boolean
  onClose: () => void
}): React.JSX.Element {
  const createTask = useAITradingStore((s) => s.createTask)
  const tasks = useAITradingStore((s) => s.tasks)
  const [favs, setFavs] = useState<TaskFavoriteItem[]>([])
  const [loading, setLoading] = useState(false)
  const [creatingId, setCreatingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [doneMsg, setDoneMsg] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setLoading(true)
    setError(null)
    setDoneMsg(null)
    void listTaskFavorites()
      .then(setFavs)
      .catch(() => setFavs([]))
      .finally(() => setLoading(false))
  }, [open])

  // 在跑任务的配置键集合（灰色不可创建判定）
  const runningKeys = useMemo(
    () =>
      new Set(
        tasks
          .filter((t) => t.status === "running")
          .map((t) => configKey(t as AITradingTask)),
      ),
    [tasks],
  )
  const existNames = useMemo(
    () => new Set(tasks.map((t) => t.name)),
    [tasks],
  )

  async function handleCreate(fav: TaskFavoriteItem): Promise<void> {
    setCreatingId(fav.id)
    setError(null)
    try {
      const payload = payloadFromSnapshot(fav, existNames)
      await createTask(payload)
      setDoneMsg(`已创建：${payload.name}`)
      setFavs((list) => list.filter((x) => x.id !== fav.id))
    } catch (e) {
      setError(e instanceof Error ? e.message : "创建失败")
    } finally {
      setCreatingId(null)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-lg max-h-[80vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle>创建优秀任务（来自任务收藏夹）</DialogTitle>
        </DialogHeader>
        <p className="text-[11px] text-[var(--text-muted)] -mt-1">
          相同配置的任务已在运行时不可创建（置灰）。创建后自动开始运行。
        </p>
        <div className="flex-1 min-h-0 overflow-y-auto space-y-2 pt-1">
          {loading && (
            <p className="text-xs text-[var(--text-muted)] text-center py-8">
              加载收藏…
            </p>
          )}
          {!loading && favs.length === 0 && (
            <p className="text-xs text-[var(--text-muted)] text-center py-8">
              暂无任务收藏。先在任务卡片上点 ⭐ 收藏跑得好的任务。
            </p>
          )}
          {favs.map((fav) => {
            const snap = fav.snapshot
            const running = runningKeys.has(configKey(snap))
            const task = (fav.task ?? snap) as Record<string, unknown>
            const busy = creatingId === fav.id
            return (
              <div
                key={fav.id}
                className="flex items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] p-2.5"
              >
                <TaskIcon
                  icon={(task.icon as string) ?? null}
                  strategyType={String(task.strategy_type ?? "ai")}
                  modelId={(task.model_id as string) ?? null}
                  providerName={(task.provider_name as string) ?? null}
                  displayName={(task.model_display_name as string) ?? null}
                  size={28}
                />
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-medium text-[var(--text-primary)] truncate">
                    {snap.name ?? "未命名"}
                  </p>
                  <p className="text-[10px] text-[var(--text-muted)] font-num truncate">
                    {snap.symbol} · {snap.timeframe} ·{" "}
                    {String(snap.strategy_type ?? "ai") === "ai"
                      ? "AI"
                      : String(snap.strategy_type)}
                    {running && (
                      <span className="text-amber-400"> · 相同任务运行中</span>
                    )}
                  </p>
                </div>
                <Button
                  size="sm"
                  disabled={running || busy}
                  onClick={() => void handleCreate(fav)}
                  title={running ? "已有相同任务在跑" : undefined}
                  className={cn(
                    "text-xs shrink-0",
                    running && "opacity-40 cursor-not-allowed",
                  )}
                >
                  {busy ? "创建中…" : "创建"}
                </Button>
              </div>
            )
          })}
          {error && <p className="text-[11px] text-red-400">{error}</p>}
          {doneMsg && (
            <p className="text-[11px] text-emerald-400">{doneMsg}</p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
