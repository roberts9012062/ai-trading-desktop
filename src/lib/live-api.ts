/**
 * 实盘交易 API —— OKX / Binance(币安) / Gate(芝麻开门) 三所对等
 *
 * 虚拟盘走 paper-api；实盘按当前所选交易所路由到 /api/live/*。
 */

import type { PaperAccountSummary, PaperOrderItem, PaperPositionItem } from "@/lib/paper-api"

const API_BASE = (process.env.NEXT_PUBLIC_API_URL ?? "").replace(/\/$/, "")

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
  const response = await fetch(`${API_BASE}${path}`, { ...options, headers })
  if (response.status === 401 && typeof window !== "undefined") {
    window.location.href = "/login"
    throw new Error("认证过期")
  }
  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: "请求失败" }))
    let detailText = `请求失败: ${response.status}`
    if (typeof error?.detail === "string") {
      detailText = error.detail
    }
    throw new Error(detailText)
  }
  return response.json() as Promise<T>
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
    multiplier: 1,
    margin_rate: 0,
    liquidation_price: Number(p.liquidation_price ?? 0),
    leverage: Number(p.leverage ?? 0),
    updated_at: "",
    /** 归属任务名（手动持仓无） */
    task_name: (p.task_name as string | null) ?? null,
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
  const res = await liveRequest<{ orders: Array<Record<string, unknown>> }>(
    `/api/live/orders?venue=${venue}&history=${history ? "true" : "false"}`
  )
  return res.orders.map((o, i) => ({
    id: String(o.id ?? o.order_id ?? `${venue}-${i}`),
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
    exchange_order_id: o.exchange_order_id ?? o.order_id ?? "",
    leverage: (o.leverage as number | null) ?? null,
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
