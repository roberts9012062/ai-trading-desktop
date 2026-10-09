"use client"
/**
 * 策略收藏夹 API 客户端 —— 文件夹（因子/任务共用）+ AI 任务收藏
 */

const API_BASE = (process.env.NEXT_PUBLIC_API_URL ?? "").replace(/\/$/, "")

async function request<T>(
  path: string,
  options: RequestInit = {},
  timeoutMs = 30_000,
): Promise<T> {
  const token =
    typeof window !== "undefined" ? localStorage.getItem("access_token") : null
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...((options.headers as Record<string, string>) ?? {}),
  }
  if (token) headers.Authorization = `Bearer ${token}`
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const response = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers,
      signal: ctrl.signal,
    })
    if (!response.ok) {
      let detail = `HTTP ${response.status}`
      try {
        const body = (await response.json()) as { detail?: string }
        if (body?.detail) detail = body.detail
      } catch {
        // ignore
      }
      throw new Error(detail)
    }
    return (await response.json()) as T
  } finally {
    clearTimeout(timer)
  }
}

export type FolderKind = "factor" | "task"

export interface StrategyFolderItem {
  id: string
  kind: FolderKind
  name: string
  created_at: string | null
}

export async function listFolders(
  kind: FolderKind,
): Promise<StrategyFolderItem[]> {
  const res = await request<{ items: StrategyFolderItem[] }>(
    `/api/strategy-folders?kind=${kind}`,
  )
  return res.items
}

export async function createFolder(
  kind: FolderKind,
  name: string,
): Promise<StrategyFolderItem> {
  return request<StrategyFolderItem>("/api/strategy-folders", {
    method: "POST",
    body: JSON.stringify({ kind, name }),
  })
}

export async function renameFolder(
  id: string,
  name: string,
): Promise<StrategyFolderItem> {
  return request<StrategyFolderItem>(`/api/strategy-folders/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ name }),
  })
}

export async function deleteFolder(id: string): Promise<void> {
  await request(`/api/strategy-folders/${id}`, { method: "DELETE" })
}

/** 任务收藏快照（收藏时的完整创建参数） */
export interface TaskFavoriteSnapshot {
  name?: string
  icon?: string | null
  symbol?: string
  symbol_name?: string
  timeframe?: string
  extra_timeframes?: string[]
  ai_bars_limit?: number
  decision_interval_sec?: number
  eval_interval_sec?: number | null
  margin_per_trade?: number | null
  leverage?: number
  margin_mode?: "cross" | "isolated"
  funding_source?: "live" | "site"
  strategy_type?: string
  strategy_params?: Record<string, unknown>
  model_row_id?: string | null
  side_mode?: string
  position_mode?: string
  fixed_qty?: number
  qty_min?: number
  qty_max?: number
  allocated_capital?: number
  capital_usage_min_pct?: number
  capital_usage_max_pct?: number
  risk_style?: string
  custom_prompt_enabled?: boolean
  custom_prompt?: string | null
  close_rules?: Record<string, unknown>
  stop_rules?: Record<string, unknown>
  /** 兜底止盈/止损（保证金收益率%）；null=关闭；旧快照无此字段 */
  max_profit_pct?: number | null
  max_loss_pct?: number | null
  loss_cooldown_enabled?: boolean
  loss_cooldown_limit?: number
  max_hold_days?: number
  close_on_stop?: boolean
  status_at_save?: string
}

export interface TaskFavoriteItem {
  id: string
  folder_id: string | null
  task_id: string | null
  note: string | null
  snapshot: TaskFavoriteSnapshot
  created_at: string
  /** 活任务数据（任务被删后为 null，按快照降级展示） */
  task: Record<string, unknown> | null
}

export async function listTaskFavorites(): Promise<TaskFavoriteItem[]> {
  const res = await request<{ items: TaskFavoriteItem[] }>(
    "/api/ai-trading/task-favorites",
  )
  return res.items
}

export async function addTaskFavorite(
  taskId: string,
  folderId: string | null,
): Promise<TaskFavoriteItem> {
  return request<TaskFavoriteItem>("/api/ai-trading/task-favorites", {
    method: "POST",
    body: JSON.stringify({ task_id: taskId, folder_id: folderId }),
  })
}

export async function moveTaskFavorite(
  id: string,
  folderId: string | null,
): Promise<TaskFavoriteItem> {
  return request<TaskFavoriteItem>(`/api/ai-trading/task-favorites/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ folder_id: folderId }),
  })
}

/** 拖拽排序：按顺序的收藏 ID 持久化 */
export async function reorderTaskFavorites(ids: string[]): Promise<void> {
  await request("/api/ai-trading/task-favorites/reorder", {
    method: "POST",
    body: JSON.stringify({ ids }),
  })
}

export async function deleteTaskFavorite(id: string): Promise<void> {
  await request(`/api/ai-trading/task-favorites/${id}`, {
    method: "DELETE",
  })
}
