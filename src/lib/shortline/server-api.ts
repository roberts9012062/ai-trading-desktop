/**
 * 短线挂载服务器 API 客户端(契约 §7/§9 端点)。
 *
 * 服务端 M-S1 已交付(/api/shortline/tasks 全套,桥接 AI 交易任务系统):
 * 创建走 {name, payload} 包装,鉴权与 factor-lab 同源(localStorage access_token)。
 */

const API_BASE = (process.env.NEXT_PUBLIC_API_URL ?? "").replace(/\/$/, "")
import type { ShortlineTaskPayload } from "./mount"
import { desktopTokensToServerV3 } from "../factor-access"
import type { ExecutionSettings, ExecutionReview, ExecutionObservation } from "./execution-review"

/** The desktop and server diverged after feature 35. Convert only at submission. */
export function serverShortlinePayload(payload: ShortlineTaskPayload): ShortlineTaskPayload {
  return { ...payload, champions: payload.champions.map((c) => {
    const tokens = desktopTokensToServerV3(c.tokens)
    // A bare extended feature has no v3 operator marker; double NEG is identity.
    if (!tokens.some((t) => t >= 128)) tokens.push(135, 135)
    return { ...c, tokens }
  }) }
}

export interface ShortlineServerTask {
  id: number | string
  name?: string
  symbol: string
  timeframe?: string
  cadence_seconds?: number
  status: string
  mode?: string
  position?: number | null
  cumulative_pnl?: number | null
  strategy_type?: string
  created_at?: string
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const token =
    typeof window !== "undefined" ? localStorage.getItem("access_token") : null
  const resp = await fetch(`${API_BASE}/api/shortline${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init?.headers ?? {}),
    },
  })
  if (!resp.ok) {
    const text = await resp.text().catch(() => "")
    throw new Error(`短线任务接口 ${path} 失败(${resp.status})${text ? `：${text.slice(0, 200)}` : ""}`)
  }
  return resp.json() as Promise<T>
}

export async function createShortlineTask(
  payload: ShortlineTaskPayload,
  name = `短线·${payload.symbol}·${payload.timeframe}`,
  execution?: ExecutionSettings,
): Promise<ShortlineServerTask> {
  return request<ShortlineServerTask>("/tasks", {
    method: "POST",
    body: JSON.stringify({ name, payload: serverShortlinePayload(payload), ...(execution ? { execution } : {}) }),
  })
}

export function reviewShortlineExecution(args: {
  payload: ShortlineTaskPayload, steps: ExecutionObservation[], dataset_sha: string,
  source: "binance_usdt" | "okx", fee_rate: number, slippage_bps: number,
} & ExecutionSettings, signal?: AbortSignal): Promise<ExecutionReview> {
  const { margin_mode: _marginMode, ...body } = args
  return request<ExecutionReview>("/execution-review", { method: "POST", signal,
    body: JSON.stringify({ ...body, payload: serverShortlinePayload(args.payload) }) })
}

export async function listShortlineTasks(): Promise<ShortlineServerTask[]> {
  const rows = await request<ShortlineServerTask[] | { items?: ShortlineServerTask[] }>("/tasks")
  return Array.isArray(rows) ? rows : (rows.items ?? [])
}

// ── 短线因子收藏(独立于因子收藏:桌面编码,消费方只有短线挂载链路) ──

export interface ShortlineFavoriteItem {
  id: string
  name: string
  symbol: string
  timeframe: string
  tokens: number[]
  text: string
  composite: number | null
  metrics: Record<string, unknown> | null
  note: string | null
  created_at: string | null
}

export async function addShortlineFavorite(payload: {
  name?: string
  symbol: string
  timeframe: string
  tokens: number[]
  text?: string
  composite?: number | null
  metrics?: Record<string, unknown> | null
  note?: string
}): Promise<ShortlineFavoriteItem> {
  return request<ShortlineFavoriteItem>("/favorites", {
    method: "POST",
    body: JSON.stringify(payload),
  })
}

export async function listShortlineFavorites(
  symbol?: string,
): Promise<ShortlineFavoriteItem[]> {
  const q = symbol ? `?symbol=${encodeURIComponent(symbol)}` : ""
  const res = await request<{ items: ShortlineFavoriteItem[] }>(`/favorites${q}`)
  return res.items
}


/** 短线打分环(最近 50 步,契约 §4) */
export interface ShortlineScoreStep {
  ts: number
  combo: number | null
  champions?: Record<string, number | null>
  action: string
  rule?: string
  stale?: boolean
  eval_error?: string | null
}

export async function getShortlineScores(taskId: string): Promise<ShortlineScoreStep[]> {
  return request<ShortlineScoreStep[]>(`/tasks/${taskId}/scores`)
}
export async function deleteShortlineFavorite(id: string): Promise<void> {
  await request(`/favorites/${id}`, { method: "DELETE" })
}
