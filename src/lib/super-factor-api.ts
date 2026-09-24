/** 超级因子挖掘 API 客户端 —— 长程任务 CRUD + 进度轮询 */

import type { Champion } from "@/lib/factor-lab-api"
import { CRYPTO_ASSETS } from "@/data/crypto-universe"

const API_BASE = (process.env.NEXT_PUBLIC_API_URL ?? "").replace(/\/$/, "")
const POLL_INTERVAL_MS = 5_000

export interface MiningSymbol {
  /** 规范符号(小写,如 btcusdt)——与合约树/因子实验室统一口径 */
  code: string
  /** 币种中文名（如 比特币） */
  name: string
  /** 具体交易对符号;桌面端内置宇宙与 code 同值(无主力合约概念),保留字段兼容 */
  symbol: string | null
  /** 交易对名称;桌面端置 null 回退 name */
  symbol_name: string | null
  bars: number
  date_from: string | null
  date_to: string | null
  /** 板块(跨币种验证伙伴分组;后端元数据源无此字段) */
  sector?: string
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
  // 桌面端本地化:可挖掘币种 = 内置加密宇宙(Binance 现货 USDT 直连可拉),
  // 不再调后端 /api/factor-mining/symbols(那是 qihuo 期货 PG 元数据口径,
  // DT 服务器上为空导致下拉无内容);bars/日期元数据按需由 Binance 拉取时体现
  return CRYPTO_ASSETS.map((a) => ({
    code: a.code,
    name: a.name,
    symbol: a.code,
    symbol_name: a.name,
    bars: 0,
    date_from: null,
    date_to: null,
    sector: a.sector,
  }))
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
