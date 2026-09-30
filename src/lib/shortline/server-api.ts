/**
 * 短线挂载服务器 API 客户端（契约 §7/§9 端点）。
 *
 * 服务器端 M-S1 尚未实现——本客户端按契约 schema 调用并优雅报错；
 * 联调（D4 门）在服务器交付后进行。
 */

const API_BASE = (process.env.NEXT_PUBLIC_API_URL ?? "").replace(/\/$/, "")
import type { ShortlineTaskPayload } from "./mount"

export interface ShortlineServerTask {
  id: number | string
  symbol: string
  timeframe: string
  cadence_seconds: number
  status: string
  mode: string
  position?: number | null
  cumulative_pnl?: number | null
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const resp = await fetch(`${API_BASE}/api/shortline${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  })
  if (!resp.ok) {
    const text = await resp.text().catch(() => "")
    throw new Error(`短线任务接口 ${path} 失败(${resp.status})${text ? `：${text.slice(0, 200)}` : ""}`)
  }
  return resp.json() as Promise<T>
}

export async function createShortlineTask(payload: ShortlineTaskPayload): Promise<ShortlineServerTask> {
  return request<ShortlineServerTask>("/tasks", { method: "POST", body: JSON.stringify(payload) })
}

export async function listShortlineTasks(): Promise<ShortlineServerTask[]> {
  return request<ShortlineServerTask[]>("/tasks")
}

export async function shortlineTaskScores(id: string | number): Promise<unknown[]> {
  return request<unknown[]>(`/tasks/${id}/scores`)
}

export async function pauseShortlineTask(id: string | number): Promise<void> {
  await request(`/tasks/${id}/pause`, { method: "POST" })
}

export async function resumeShortlineTask(id: string | number): Promise<void> {
  await request(`/tasks/${id}/resume`, { method: "POST" })
}

export async function stopShortlineTask(id: string | number): Promise<void> {
  await request(`/tasks/${id}/stop`, { method: "POST" })
}
