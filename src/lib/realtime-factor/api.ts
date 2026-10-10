import { request, type AITradingTask } from '../ai-trading-api'
import type { KlineBar } from '@/types'
import type { Cadence } from './model'

export interface Seed {task: AITradingTask; bars: KlineBar[]; limit: number; server_ms: number; source: string}
export interface Lease {token: string; interval: Cadence; server_ms: number; expires_at: number}
const path=(id: string, action: string)=>`/api/ai-trading/tasks/${encodeURIComponent(id)}/realtime/${action}`
const post=<T>(id: string, action: string, body: unknown)=>request<T>(path(id,action),{
  method:'POST',body:JSON.stringify(body),signal:AbortSignal.timeout(action==='decision'?20000:8000),
})
export const seedTask=(id: string)=>request<Seed>(path(id,'seed'),{signal:AbortSignal.timeout(90000)})
export const startTask=(id: string, interval: Cadence)=>post<Lease>(id,'start',{interval})
export const stopTask=(id: string, token: string)=>post<{released: boolean}>(id,'stop',{token})
export const renewTask=(id: string, token: string, computed_at: number, market_at: number)=>post<{expires_at: number}>(id,'heartbeat',{token,computed_at,market_at})
export interface Execution {action?: string; order_id?: string|null; reason?: string; model?: {reason?: string}; status?: string; skipped?: boolean}
export const submitScore=(id: string, token: string, request_id: string, sampled_at: number, score: number)=>post<Execution>(id,'decision',{token,request_id,sampled_at,score})
