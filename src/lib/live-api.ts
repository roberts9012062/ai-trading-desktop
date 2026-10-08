/**
 * 实盘交易 API —— OKX / Binance(币安) / Gate(芝麻开门) 三所对等
 *
 * 虚拟盘走 paper-api；实盘按当前所选交易所路由到 /api/live/*。
 */

import type { PaperAccountSummary, PaperOrderItem, PaperPositionItem } from "@/lib/paper-api"

const API_BASE = (process.env.NEXT_PUBLIC_API_URL ?? "").replace(/\/$/, "")

export function liveErrorMessage(error: unknown, fallback = '交易请求失败'): string {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === 'string' && error.trim()) return error.trim()
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') return error.message
  return fallback
}

class LiveRequestError extends Error {
  constructor(message: string, readonly retryable = false) { super(message) }
}

/** 带鉴权的 JSON 请求（与 paper-api 同款） */
async function liveRequest<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token =
    typeof window !== "undefined" ? localStorage.getItem("access_token") : null
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...((options.headers as Record<string, string>) ?? {}),
  }
  if (token) {
    headers["Authorization"] = `Bearer ${token}`
  }
  try {
    const response = await fetch(`${API_BASE}${path}`, { ...options, headers })
    if (response.status === 401 && typeof window !== "undefined") {
      window.location.href = "/login"
      throw new LiveRequestError("认证过期")
    }
    if (!response.ok) {
      const error = await response.json().catch(() => ({}))
      let detailText = `请求失败: ${response.status}`
      if (typeof error?.detail === "string") {
        detailText = error.detail
      }
      throw new LiveRequestError(detailText, [408, 500, 502, 503, 504].includes(response.status))
    }
    return await response.json() as T
  } catch (error) {
    if (error instanceof LiveRequestError) throw error
    const message = liveErrorMessage(error)
    const cancelled = options.signal?.aborted || (error instanceof Error && error.name === 'AbortError') || /request cancel(?:led|ed)/i.test(message)
    throw new LiveRequestError(message, !cancelled)
  }
}

/** 交易所标识 */
export type TradingVenue = "okx" | "binance" | "gate"

export const VENUES: { venue: TradingVenue; name: string; short: string }[] = [
  { venue: "okx", name: "OKX", short: "OKX" },
  { venue: "binance", name: "Binance 币安", short: "币安" },
  { venue: "gate", name: "Gate 芝麻开门", short: "芝麻开门" },
]

export function venueName(venue: string): string {
  return VENUES.find((v) => v.venue === venue)?.name ?? venue.toUpperCase()
}

/** localStorage 持久化当前交易所 */
const VENUE_KEY = "crypto-live-venue"

export function getStoredVenue(): TradingVenue {
  if (typeof window === "undefined") return "okx"
  const v = window.localStorage.getItem(VENUE_KEY)
  return v === "binance" || v === "gate" || v === "okx" ? v : "okx"
}

export function storeVenue(venue: TradingVenue): void {
  if (typeof window !== "undefined") {
    window.localStorage.setItem(VENUE_KEY, venue)
  }
}

// ===== 凭证 =====

export interface VenueCredential {
  venue: string
  api_key_masked: string
  demo: boolean
  label: string
  status: string
  last_checked_at: string | null
  last_check_ok: boolean | null
  last_error: string
  updated_at: string | null
}

export async function getCredentialsApi(): Promise<VenueCredential[]> {
  const res = await liveRequest<{ credentials: VenueCredential[] }>("/api/live/credentials")
  return res.credentials
}

export async function saveCredentialApi(payload: {
  venue: TradingVenue
  api_key: string
  secret: string
  passphrase?: string
  demo?: boolean
  label?: string
}): Promise<{ ok: boolean; error?: string }> {
  return liveRequest("/api/live/credentials", {
    method: "PUT",
    body: JSON.stringify(payload),
  })
}

export async function deleteCredentialApi(venue: string): Promise<void> {
  await liveRequest(`/api/live/credentials/${venue}`, { method: "DELETE" })
}

export async function testCredentialApi(
  venue: string
): Promise<{ ok: boolean; equity?: number; available?: number; demo?: boolean; error?: string }> {
  return liveRequest(`/api/live/credentials/${venue}/test`, { method: "POST" })
}

// ===== 账户 / 持仓 / 委托（映射为 paper 形状，复用既有渲染） =====

export async function getLiveAccountApi(venue: string): Promise<PaperAccountSummary> {
  const raw = await liveRequest<{
    equity: number
    available: number
    unrealized_pnl: number
    currency: string
    venue: string
    venue_name: string
    demo: boolean
  }>(`/api/live/account?venue=${venue}`)
  return {
    account_id: `live-${venue}`,
    currency: "USDT",
    balance: raw.available,
    available_margin: raw.available,
    frozen_margin: 0,
    position_margin: Math.max(0, raw.equity - raw.available),
    total_equity: raw.equity,
    realized_pnl: 0,
    unrealized_pnl: raw.unrealized_pnl,
    today_pnl: raw.unrealized_pnl,
    total_claimed: 0,
    total_deposit: 0,
    total_withdraw: 0,
    risk_rate: 0,
    last_claim_month: null,
    current_claim_month: "",
    can_claim: false,
    claim_amount: 0,
    updated_at: null,
    venue_name: raw.venue_name,
    demo: raw.demo,
  }
}

export async function getLivePositionsApi(venue: string): Promise<PaperPositionItem[]> {
  const res = await liveRequest<{ positions: Array<Record<string, unknown>> }>(
    `/api/live/positions?venue=${venue}`
  )
  return res.positions.map((p, i) => ({
    id: `${venue}-${p.symbol}-${i}`,
    symbol: String(p.symbol),
    symbol_name: String(p.symbol_name ?? p.symbol),
    direction: p.direction as "long" | "short",
    // 来源归属：后端按未配对开仓镜像判定 ai/quant，无任务归属=manual
    source: (p.source as string | undefined) ?? "manual",
    quantity: Number(p.quantity),
    available_quantity: Number(p.quantity),
    avg_price: Number(p.avg_price),
    margin: Number(p.margin),
    realized_pnl: 0,
    unrealized_pnl: Number(p.unrealized_pnl),
    mark_price: p.mark_price == null ? null : Number(p.mark_price),
    task_id: (p.task_id as string | null) ?? null,
    multiplier: 1,
    margin_rate: 0,
    liquidation_price: Number(p.liquidation_price ?? 0),
    leverage: Number(p.leverage ?? 0),
    updated_at: "",
    /** 归属任务名（手动持仓无） */
    task_name: (p.task_name as string | null) ?? null,
    margin_mode: (p.margin_mode as string | undefined) ?? "cross",
  })) as PaperPositionItem[]
}

/**
 * 交易所原生订单状态 → 前端统一枚举（与虚拟盘 paper 一致）
 * pending/partially_filled/filled/cancelled/rejected/error
 */
function normalizeLiveStatus(raw: string): string {
  const s = raw.trim().toLowerCase()
  if (s === "live" || s === "open" || s === "new") return "pending"
  if (s === "partially_filled") return "partially_filled"
  if (s === "filled") return "filled"
  if (s === "canceled" || s === "cancelled") return "cancelled"
  return s || "pending"
}

export async function getLiveOrdersApi(
  venue: string,
  history = false
): Promise<PaperOrderItem[]> {
  const read = async () => {
    const response = await liveRequest<{ orders: Array<Record<string, unknown>> }>(
      `/api/live/orders?venue=${venue}&history=${history ? "true" : "false"}`
    )
    if (!Array.isArray(response.orders)) throw new LiveRequestError('委托查询响应格式错误')
    return response
  }
  let res: Awaited<ReturnType<typeof read>>
  try { res = await read() } catch (error) {
    // Read-only history can recover from a transient Rust transport/body error.
    // Submission, cancellation and authorization failures are never retried.
    if (!history || !(error instanceof LiveRequestError) || !error.retryable) throw error
    await new Promise(resolve => setTimeout(resolve, 250))
    res = await read()
  }
  return res.orders.map((o, i) => ({
    id: o.order_kind === "algo" ? `algo:${o.algo_id ?? o.order_id ?? o.id}` : String(o.id ?? o.order_id ?? `${venue}-${i}`),
    symbol: String(o.symbol),
    symbol_name: String(o.symbol_name ?? o.symbol),
    // 交易所挂单接口字段为 side；历史镜像为 direction
    direction: (o.direction ?? o.side) as "buy" | "sell",
    offset: o.offset as "open" | "close",
    order_type: o.order_type as "limit" | "market",
    price: Number(o.price ?? o.avg_price ?? 0),
    quantity: Number(o.quantity),
    filled_qty: Number(o.filled_qty ?? 0),
    status: normalizeLiveStatus(String(o.status ?? "")),
    source: "manual",
    frozen_margin: 0,
    fee: Number(o.fee ?? 0),
    realized_pnl: Number(o.realized_pnl ?? 0),
    created_at: String(o.created_at ?? ""),
    updated_at: String(o.updated_at ?? o.created_at ?? ""),
    filled_at: (o.filled_at as string | null) ?? null,
    exchange_order_id: o.order_kind === "algo" ? "" : o.exchange_order_id ?? o.order_id ?? "",
    order_kind: o.order_kind ?? "regular",
    algo_id: o.algo_id ?? null,
    trigger_price: o.trigger_price == null ? null : Number(o.trigger_price),
    close_fraction: Number(o.close_fraction ?? 0),
    can_cancel: o.can_cancel,
    can_amend: o.can_amend,
    leverage: (o.leverage as number | null) ?? null,
    margin_mode: (o.margin_mode as string | null) ?? null,
    tp_price: (o.tp_price as number | null) ?? null,
    sl_price: (o.sl_price as number | null) ?? null,
  })) as PaperOrderItem[]
}

export interface PlaceLiveOrderRequest {
  venue: TradingVenue
  symbol: string
  direction: "buy" | "sell"
  offset: "open" | "close"
  order_type: "limit" | "market"
  price: number | null
  quantity: number | null
  margin_usdt?: number | null
  leverage?: number | null
  /** 保证金模式 cross 全仓 / isolated 逐仓 */
  margin_mode?: "cross" | "isolated"
  tp_price?: number | null
  sl_price?: number | null
  reduce_only?: boolean
}

export async function placeLiveOrderApi(
  payload: PlaceLiveOrderRequest
): Promise<Record<string, unknown>> {
  return liveRequest("/api/live/orders", {
    method: "POST",
    body: JSON.stringify(payload),
  })
}

export async function cancelLiveOrderApi(
  venue: string,
  orderId: string,
  symbol: string
): Promise<void> {
  await liveRequest(
    `/api/live/orders/${encodeURIComponent(orderId)}?venue=${venue}&symbol=${encodeURIComponent(symbol)}`,
    { method: "DELETE" }
  )
}

export async function closeLivePositionApi(
  venue: string,
  symbol: string,
  posSide: "long" | "short" | null
): Promise<void> {
  await liveRequest("/api/live/positions/close", {
    method: "POST",
    body: JSON.stringify({ venue, symbol, pos_side: posSide }),
  })
}

export async function setLiveLeverageApi(
  venue: string,
  symbol: string,
  leverage: number
): Promise<void> {
  await liveRequest("/api/live/leverage", {
    method: "POST",
    body: JSON.stringify({ venue, symbol, leverage }),
  })
}

// ---------- 划转 / 模拟盘资金 / 条件单 / 改单（OKX 文档对齐批次） ----------

export async function transferFundsApi(payload: {
  venue: string
  ccy: string
  amt: number
  from_account: string
  to_account: string
}): Promise<{ ok: boolean; transfer_id: string }> {
  return liveRequest("/api/live/transfer", {
    method: "POST",
    body: JSON.stringify(payload),
  })
}

/** 账户模式（OKX acctLv；1=纯现货无法合约交易，本系统仅支持合约） */
export interface AccountMode {
  supported: boolean
  acct_lv: string | null
  label: string | null
  can_trade_contract: boolean
}

export async function getAccountModeApi(venue: string): Promise<AccountMode> {
  return liveRequest(`/api/live/account-mode?venue=${venue}`)
}

/** 切换账户模式（仅允许升级到可合约交易档位 2/3/4） */
export async function setAccountModeApi(
  venue: string,
  target: string,
): Promise<{ ok: boolean; changed: boolean; acct_lv: string | null; label: string | null }> {
  return liveRequest("/api/live/account-mode", {
    method: "POST",
    body: JSON.stringify({ venue, target }),
  })
}

export async function adjustDemoBalanceApi(payload: {
  venue: string
  direction: "increase" | "reduce"
  adjustments: { ccy: string; amt: number }[]
}): Promise<{ ok: boolean; raw?: Record<string, unknown> }> {
  return liveRequest("/api/live/demo-balance", {
    method: "POST",
    body: JSON.stringify(payload),
  })
}

export async function placePositionTpslApi(payload: {
  venue: string
  symbol: string
  pos_side: "long" | "short" | null
  tp_price: number | null
  sl_price: number | null
}): Promise<{ ok: boolean; algo_id: string }> {
  return liveRequest("/api/live/positions/tpsl", {
    method: "POST",
    body: JSON.stringify(payload),
  })
}

export async function amendLiveOrderApi(payload: {
  venue: string
  order_id: string
  symbol: string
  new_price: number | null
  new_qty: number | null
}): Promise<{ ok: boolean }> {
  return liveRequest("/api/live/orders/amend", {
    method: "POST",
    body: JSON.stringify(payload),
  })
}

export interface LiveBill {
  ts_ms: number
  symbol: string
  type: string
  sub_type: string
  amount: number
  fee: number
  pnl: number
  notes: string
}

export async function getLiveBillsApi(
  venue: string,
  limit = 50
): Promise<LiveBill[]> {
  const res = await liveRequest<{ bills: LiveBill[] }>(
    `/api/live/bills?venue=${venue}&limit=${limit}`
  )
  return res.bills
}

// ===== 账户日收益统计（工作台收益分析，服务器基于成交明细聚合） =====

/** 账户日收益统计（OKX 成交明细口径）——工作台数据看板 */
export interface DailyPnlRow {
  date: string // 北京自然日 YYYY-MM-DD
  pnl: number
  fee: number
  /** 手续费净支出（返佣为负）；新服务器提供 */
  fee_cost?: number
  /** 已结算资金费收支：收入为正、支出为负 */
  funding?: number
  /** 毛平仓盈亏减手续费，加已结算资金费；避免客户端重复扣费 */
  net_after_costs?: number
  /** 盈利平仓合计（逐笔 fillPnl>0） */
  win_pnl: number
  /** 亏损平仓合计（逐笔 fillPnl<0） */
  loss_pnl: number
  net: number
  cumulative: number
  trades: number
}

export interface DailyPnlSummary {
  total_profit: number
  total_loss: number
  profit_ratio: number | null
  net: number
  trade_days: number
  total_trades: number
}

/** 仅 OKX 支持；days 上限 90（服务器按 fills 覆盖范围钳制） */
export async function getDailyPnlApi(
  venue = "okx",
  days = 90
): Promise<{ days: DailyPnlRow[]; summary: DailyPnlSummary | null }> {
  return liveRequest(`/api/live/daily-pnl?venue=${venue}&days=${days}`)
}

/** 今日按任务归属的盈亏/手续费明细 */
export interface TaskTradeRow {
  time: string
  symbol: string
  direction: string
  offset: string
  qty: number
  avg_price: number
  pnl: number
  fee: number
}

export interface TaskPnlGroup {
  task_id: string | null
  task_name: string
  symbol: string
  trades: TaskTradeRow[]
  win: number
  loss: number
  fee: number
  net: number
}

export interface TaskPnlTotal {
  win: number
  loss: number
  fee: number
  net: number
}

export async function getDailyPnlTasksApi(
  venue = "okx"
): Promise<{ tasks: TaskPnlGroup[]; total: TaskPnlTotal | null }> {
  return liveRequest(`/api/live/daily-pnl/tasks?venue=${venue}`)
}

export async function getLiveFeeRatesApi(
  venue: string,
  symbol?: string
): Promise<{ symbol: string; maker: number; taker: number }[]> {
  const qs = new URLSearchParams({ venue })
  if (symbol) qs.set("symbol", symbol)
  const res = await liveRequest<{
    rates: { symbol: string; maker: number; taker: number }[]
  }>(`/api/live/fee-rates?${qs.toString()}`)
  return res.rates
}
