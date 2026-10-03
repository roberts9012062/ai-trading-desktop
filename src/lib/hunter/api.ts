import type { Bar, Cycle, Direction } from "./rules"

export interface HunterConfig {
  name: string; capital: number; leverage: number; venue: "okx"; margin_mode: "isolated" | "cross"; cycles: Cycle[];
  brain: "rules" | "llm" | "jev"; model_id: string | null; rule_fallback: boolean;
  direction: "long" | "both"; whitelist: string[]; blacklist: string[];
  pool_size: number; max_positions: number; scan_seconds: number;
}
export interface Opportunity {
  id: string; task_id: string | null; symbol: string; cycle: Cycle; status: string;
  plan: { entry: number; stop: number; quantity: number; risk_budget: number; direction: Direction; leverage?: number; margin?: number; margin_mode?: "isolated" | "cross" };
  runtime: { stop?: number; last_price?: number; reason?: string; unrealized?: number };
  net_profit: number; finished_at: string | null;
}
export interface Hunter {
  id: string; name: string; status: "running" | "paused" | "stopping" | "stopped";
  trading_mode: string; config: HunterConfig; capital: number; equity: number; blocks: string[];
  runtime: { realized?: number; unrealized?: number; qualification?: string };
  stats: { trades: number; win_rate: number | null; profit_factor: number | null; payoff: number | null };
  opportunities: Opportunity[];
}
export interface HunterData { bars: Record<string, Bar[]>; market: Bar[]; market_week: Bar[]; now: number }
export interface HunterTicker { symbol: string; price: number; bid: number; ask: number; turnover: number; spread: number; ts_ms: number }
export interface HunterSymbol { symbol: string; name: string }

async function request<T>(path: string, init: RequestInit = {}, signal?: AbortSignal): Promise<T> {
  const token = localStorage.getItem("access_token")
  if (!token) throw new Error("请先登录")
  const base = (process.env.NEXT_PUBLIC_API_URL ?? "").replace(/\/$/, "")
  const response = await fetch(base + "/api/hunter" + path, {
    ...init, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60000)]) : AbortSignal.timeout(60000),
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
  })
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { detail?: unknown }
    const message = typeof body.detail === "string" ? body.detail :
      Array.isArray(body.detail) ? body.detail.map(item => typeof item?.msg === "string" ? item.msg : "参数不合格").join("；") :
      response.status === 404 ? "服务器尚未安装多周期猎手模块" : "猎手请求失败：" + response.status
    const error = new Error(message) as Error & { status?: number }
    error.status = response.status
    throw error
  }
  return response.json() as Promise<T>
}
export const hunterApi = {
  symbols: (signal?: AbortSignal) => request<HunterSymbol[]>("/symbols", {}, signal),
  capabilities: () => request<{ live_qualified: boolean; trading_mode: string; reason: string }>("/capabilities"),
  list: (signal?: AbortSignal) => request<Hunter[]>("/groups", {}, signal),
  create: (config: HunterConfig) => request<Hunter>("/groups", { method: "POST", body: JSON.stringify(config) }),
  universe: (id: string, signal?: AbortSignal) => request<HunterTicker[]>("/groups/" + id + "/universe", {}, signal),
  data: (id: string, symbol: string, cycle: Cycle, signal?: AbortSignal) => request<HunterData>("/groups/" + id + "/data?" + new URLSearchParams({ symbol, cycle }), {}, signal),
  mount: (id: string, body: { symbol: string; cycle: Cycle; direction: Direction; signal_at: number }, signal?: AbortSignal) => request<{ id: string; task_id: string; duplicate: boolean }>("/groups/" + id + "/mount", { method: "POST", body: JSON.stringify(body) }, signal),
  control: (id: string, action: "pause" | "resume" | "stop" | "stop_close") => request<Hunter>("/groups/" + id + "/control", { method: "POST", body: JSON.stringify({ action }) }),
}
