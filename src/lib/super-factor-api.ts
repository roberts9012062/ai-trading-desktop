/** 超级因子挖掘 API 客户端 —— 长程任务 CRUD + 进度轮询 */

import type { Champion } from "@/lib/factor-lab-api"

const API_BASE = (process.env.NEXT_PUBLIC_API_URL ?? "").replace(/\/$/, "")
const POLL_INTERVAL_MS = 5_000

export interface MiningSymbol {
  /** 品种代码（如 rb） */
  code: string
  /** 品种中文名（如 螺纹钢） */
  name: string
  /** 主力合约符号（如 rb2701），与因子实验室品种选项同口径；无映射时为 null */
  symbol: string | null
  /** 主力合约名称（如 螺纹钢2701）；无映射时为 null */
  symbol_name: string | null
  bars: number
  date_from: string | null
  date_to: string | null
}

export interface SupportedTimeframe {
  value: string
  label: string
  long_history: boolean
  note: string
}

export interface SupportedInfo {
  timeframes: SupportedTimeframe[]
  device_options: { value: string; label: string; available: boolean }[]
  max_running_per_user: number
}

/** 挖掘任务（列表/详情通用，不含 champion 详情） */
export interface MiningTask {
  id: string
  name: string
  symbol: string
  timeframe: string
  population: number
  generations: number
  max_depth: number
  train_ratio: number
  walk_forward_folds: number
  device: string
  bars_count: number
  data_range_from: string | null
  data_range_to: string | null
  status: "pending" | "running" | "paused" | "completed" | "failed" | "cancelled"
  pause_reason: string | null
  current_generation: number
  best_composite: number
  progress_pct: number
  champions_count: number
  error_msg: string | null
  started_at: string | null
  completed_at: string | null
  updated_at: string | null
  created_at?: string | null
}

export interface CreateTaskPayload {
  symbol: string
  timeframe: string
  population: number
  generations: number
  max_depth: number
  train_ratio: number
  walk_forward_folds: number
  seed_tokens?: number[][]
  device?: string
  name?: string
}

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
    const res = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers,
      signal: ctrl.signal,
    })
    if (res.status === 401 && typeof window !== "undefined") {
      window.location.href = "/login"
      throw new Error("认证过期")
    }
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: "请求失败" }))
      throw new Error(typeof err?.detail === "string" ? err.detail : "请求失败")
    }
    return res.json() as Promise<T>
  } finally {
    clearTimeout(timer)
  }
}

export async function fetchSupported(): Promise<SupportedInfo> {
  return request<SupportedInfo>("/api/factor-mining/supported")
}

export async function fetchMiningSymbols(): Promise<MiningSymbol[]> {
  const r = await request<{ total: number; items: MiningSymbol[] }>(
    "/api/factor-mining/symbols",
  )
  return r.items
}

export async function createTask(
  payload: CreateTaskPayload,
): Promise<MiningTask> {
  return request<MiningTask>("/api/factor-mining/tasks", {
    method: "POST",
    body: JSON.stringify(payload),
  })
}

export async function listTasks(): Promise<MiningTask[]> {
  const r = await request<{ total: number; items: MiningTask[] }>(
    "/api/factor-mining/tasks",
  )
  return r.items
}

export async function getTask(id: string): Promise<MiningTask> {
  return request<MiningTask>(`/api/factor-mining/tasks/${id}`)
}

export async function pauseTask(id: string): Promise<MiningTask> {
  return request<MiningTask>(`/api/factor-mining/tasks/${id}/pause`, {
    method: "POST",
  })
}

export async function resumeTask(id: string): Promise<MiningTask> {
  return request<MiningTask>(`/api/factor-mining/tasks/${id}/resume`, {
    method: "POST",
  })
}

export async function cancelTask(id: string): Promise<MiningTask> {
  return request<MiningTask>(`/api/factor-mining/tasks/${id}/cancel`, {
    method: "POST",
  })
}

export async function deleteTask(id: string): Promise<void> {
  await request<{ ok: boolean }>(`/api/factor-mining/tasks/${id}`, {
    method: "DELETE",
  })
}

export async function getChampions(id: string): Promise<Champion[]> {
  const r = await request<{ total: number; champions: Champion[] }>(
    `/api/factor-mining/tasks/${id}/champions`,
  )
  return r.champions
}

export { POLL_INTERVAL_MS }
