import type { Bar, Cycle, Direction, RuleVersion, EntryKind } from "./rules"
import type { ProfitLockConfig, ProfitLockUpdateResult } from "../ai-trading-api"
import type { MacdPeriod } from "./macd-ma20"
export type HunterCycle = Cycle | MacdPeriod

export interface HunterConfig {
  name: string; capital?: number; leverage: number; venue: "okx"; margin_mode: "isolated" | "cross"; cycles: HunterCycle[];
  brain: "rules" | "llm" | "jev"; model_id: string | null; rule_fallback: boolean;
  direction: "long" | "short" | "both"; whitelist: string[]; blacklist: string[];
  pool_size: number; max_positions: number; scan_seconds: number;
  scan_location?: "desktop" | "server";
  strategy_version?: RuleVersion;
  profit_lock?: ProfitLockConfig;
  position_mode?: "fixed_margin" | "half" | "full" | "scale_in" | "capital_pct";
  margin_per_trade?: number;
  capital_usage_min_pct?: number;
  capital_usage_max_pct?: number;
  max_profit_pct?: number | null;
  max_loss_pct?: number | null;
  loss_cooldown_enabled?: boolean;
  loss_cooldown_limit?: number;
  rebound_threshold_pct?: number;
}
export interface Opportunity {
  id: string; task_id: string | null; symbol: string; cycle: HunterCycle; status: string;
  plan: { entry: number; stop: number | null; quantity: number; risk_budget?: number; direction: Direction; leverage?: number; margin?: number; margin_mode?: "isolated" | "cross"; entry_kind?: EntryKind | "macd_ma20" | "rebound"; version?: RuleVersion; target_price?: number; min_net_rr?: number; manual_entry?: boolean; thrust?: number; threshold?: number };
  runtime: { stop?: number | null; last_price?: number; reason?: string; note?: string; unrealized?: number; entry?: number; initial_qty?: number; technical_exit?: string; net_peak_r?: number; swing?: { regime: string; reason: string } };
  net_profit: number; finished_at: string | null;
}
export interface Hunter {
  id: string; name: string; status: "running" | "paused" | "stopping" | "stopped";
  trading_mode: string; config: HunterConfig; capital: number; equity: number; blocks: string[];
  runtime: { realized?: number; unrealized?: number; qualification?: string; execution_account?: { execution_mode: "virtual" | "okx_demo" | "okx_live" }; discovery?: DiscoveryStatus | null;
    hosting?: { blocked?: string; note?: string; cycles: Record<string, { at?: number; started_at?: number; phase: string; note: string; counts: Record<string, number> }> } | null };
  stats: { trades: number; win_rate: number | null; profit_factor: number | null; payoff: number | null };
  opportunities: Opportunity[];
}
export interface ScanReport { cycle: Cycle; scan_id: string; elapsed: number; counts: Record<string, number>; signals: string[]; note: string }
export interface DiscoveryStatus { started_at: number; last_report_at: number; hour_signals: number; hour_mounted: number; overdue: boolean; stale: boolean;
  cycles: Partial<Record<Cycle, { at: number; elapsed: number; counts: Record<string, number>; note: string }>> }
export interface HunterData { bars: Record<string, Bar[]>; market: Bar[]; market_week: Bar[]; now: number }
export interface DeltaBars { reset: boolean; rows: Bar[] }
export interface RankingSnapshot { symbol: string; history_ok: boolean; relative: number | null; error?: string }
export interface ContextSnapshot { symbol: string; bars: Record<string, DeltaBars>; market: DeltaBars; market_week: DeltaBars; now: number; error?: string }
export interface SnapshotBody { cycle: Cycle; phase: "ranking" | "context"; symbols: string[]; cursors?: Record<string, Record<string, number>> }
export interface HunterTicker { symbol: string; price: number; bid: number; ask: number; turnover: number; spread: number; ts_ms: number }
export interface HunterSymbol { symbol: string; name: string }
export interface HunterCapabilities {
  live_qualified: boolean; trading_mode: string; reason: string;
  can_start?: boolean; execution_mode?: "virtual" | "okx_demo" | "okx_live" | "unavailable";
  supported_versions?: RuleVersion[];
  server_hosting_available?: boolean;
  can_server_host?: boolean;
}

export function canStartHunter(cap: HunterCapabilities): boolean {
  return cap.can_start ?? cap.trading_mode === "virtual"
}

export function hunterAccountLabel(mode?: HunterCapabilities["execution_mode"]): string {
  return ({ virtual: "站内模拟交易", okx_demo: "OKX API 模拟盘", okx_live: "OKX API 实盘",
    unavailable: "未配置有效 OKX API" } as const)[mode ?? "unavailable"]
}

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
  hosting: (id: string, scan_location: "desktop" | "server") => request<Hunter>("/groups/" + encodeURIComponent(id) + "/hosting", { method: "PATCH", body: JSON.stringify({ scan_location }) }),
  report: (id: string, report: ScanReport, signal?: AbortSignal) => request<{ ok: boolean }>("/groups/" + id + "/scan-report", { method: "POST", body: JSON.stringify(report) }, signal),
  setProfitLock: (id: string, profit_lock: ProfitLockConfig) => request<ProfitLockUpdateResult>("/groups/" + encodeURIComponent(id) + "/profit-lock", { method: "PATCH", body: JSON.stringify({ profit_lock }) }),
  symbols: (signal?: AbortSignal) => request<HunterSymbol[]>("/symbols", {}, signal),
  capabilities: () => request<HunterCapabilities>("/capabilities"),
  list: (signal?: AbortSignal) => request<Hunter[]>("/groups", {}, signal),
  create: (config: HunterConfig) => request<Hunter>("/groups", { method: "POST", body: JSON.stringify(config) }),
  universe: (id: string, signal?: AbortSignal) => request<HunterTicker[]>("/groups/" + id + "/universe", {}, signal),
  data: (id: string, symbol: string, cycle: HunterCycle, signal?: AbortSignal) => request<HunterData>("/groups/" + id + "/data?" + new URLSearchParams({ symbol, cycle }), {}, signal),
  snapshot: <T extends RankingSnapshot | ContextSnapshot>(id: string, body: SnapshotBody, signal?: AbortSignal) => request<{ items: T[] }>("/groups/" + id + "/snapshot", { method: "POST", body: JSON.stringify(body) }, signal),
  mount: (id: string, body: { symbol: string; cycle: HunterCycle; direction: Direction; signal_at: number; entry_kind?: EntryKind | "macd_ma20" | "rebound" }, signal?: AbortSignal) => request<{ id?: string; task_id?: string; duplicate?: boolean; skipped?: boolean; reason?: string }>("/groups/" + id + "/mount", { method: "POST", body: JSON.stringify(body) }, signal),
  manualEntry: (id: string, opportunityId: string, signal?: AbortSignal) => request<{ id: string; task_id: string; status: string }>("/groups/" + encodeURIComponent(id) + "/opportunities/" + encodeURIComponent(opportunityId) + "/manual-entry", { method: "POST" }, signal),
  control: (id: string, action: "pause" | "resume" | "stop" | "stop_close" | "upgrade" | "upgrade_adaptive" | "upgrade_swing" | "set_pool", pool_size?: number) => request<Hunter>("/groups/" + id + "/control", { method: "POST", body: JSON.stringify({ action, ...(pool_size === undefined ? {} : { pool_size }) }) }),
}
