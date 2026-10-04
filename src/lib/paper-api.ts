/** 模拟交易 / 虚拟资金 API 客户端 */

/** 模拟账户概览 */
export interface PaperAccountSummary {
  account_id: string
  currency: string
  balance: number
  available_margin: number
  frozen_margin: number
  position_margin: number
  total_equity: number
  realized_pnl: number
  unrealized_pnl: number
  today_pnl: number
  total_claimed: number
  total_deposit: number
  total_withdraw: number
  risk_rate: number
  last_claim_month: string | null
  current_claim_month: string
  can_claim: boolean
  claim_amount: number
  updated_at: string | null
  /** 实盘扩展：交易所与模拟盘标记（virtual 模式无） */
  venue_name?: string
  demo?: boolean
}

/** 资金流水项 */
export interface PaperLedgerItem {
  id: string
  time: string
  type: string
  amount: number
  balance: number
  description: string
  ref_type: string | null
  ref_id: string | null
}

/** 模拟委托 */
export interface PaperOrderItem {
  id: string
  symbol: string
  symbol_name: string
  direction: "buy" | "sell" | string
  offset: "open" | "close" | string
  order_type: "limit" | "market" | string
  price: number
  quantity: number
  filled_qty: number
  status: string
  /** 委托来源：manual/ai/quant */
  source: "manual" | "ai" | "quant" | string
  frozen_margin: number
  fee: number
  realized_pnl: number
  created_at: string
  updated_at: string
  filled_at: string | null
  /** 实盘扩展：杠杆 / 开平 / 止盈止损（virtual 无） */
  leverage?: number | null
  /** 实盘扩展：保证金模式 cross/isolated（virtual 无） */
  margin_mode?: string | null
  tp_price?: number | null
  sl_price?: number | null
  /** 实盘扩展：交易所订单号（挂单/历史合并去重用；virtual 无） */
  exchange_order_id?: string
}

/** 模拟持仓 */
export interface PaperPositionItem {
  id: string
  symbol: string
  symbol_name: string
  direction: "long" | "short" | string
  source: "manual" | "ai" | "quant" | string
  quantity: number
  available_quantity: number
  avg_price: number
  margin: number
  realized_pnl: number
  multiplier: number
  margin_rate: number
  tp_price?: number | null
  sl_price?: number | null
  updated_at: string
  /** 实盘扩展：浮动盈亏 / 强平价 / 杠杆（virtual 模式无） */
  unrealized_pnl?: number
  mark_price?: number | null
  task_id?: string | null
  liquidation_price?: number
  leverage?: number
  /** 实盘扩展：归属任务名（后端按开仓镜像判定来源；手动持仓无） */
  task_name?: string | null
  /** 保证金模式 cross 全仓 / isolated 逐仓（virtual 模式无） */
  margin_mode?: string | null
}

/** 下单请求 */
export interface PlacePaperOrderRequest {
  symbol: string
  direction: "buy" | "sell"
  offset: "open" | "close"
  source?: "manual" | "ai" | "quant"
  order_type: "limit" | "market"
  price: number
  quantity: number
  symbol_name: string
  multiplier: number | null
  margin_rate: number | null
  margin_usdt?: number | null
  leverage?: number | null
  tp_price?: number | null
  sl_price?: number | null
}

const API_BASE = (process.env.NEXT_PUBLIC_API_URL ?? "").replace(/\/$/, "")

/** 带鉴权的 JSON 请求 */
async function paperRequest<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token =
    typeof window !== "undefined" ? localStorage.getItem("access_token") : null
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...((options.headers as Record<string, string>) ?? {}),
  }
  if (token) {
    headers["Authorization"] = `Bearer ${token}`
  }

  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers,
  })

  if (response.status === 401 && typeof window !== "undefined") {
    window.location.href = "/login"
    throw new Error("认证过期")
  }

  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: "请求失败" }))
    let detailText = `请求失败: ${response.status}`
    if (typeof error?.detail === "string") {
      detailText = error.detail
    } else if (Array.isArray(error?.detail)) {
      detailText = error.detail
        .map((item: { msg?: string }) => item?.msg ?? JSON.stringify(item))
        .join("; ")
    }
    throw new Error(detailText)
  }

  return response.json() as Promise<T>
}

/** 获取模拟账户 */
export async function getPaperAccount(): Promise<PaperAccountSummary> {
  return paperRequest<PaperAccountSummary>("/api/paper/account")
}

/** 领取本月虚拟练习金 */
export async function claimPaperFunds(): Promise<PaperAccountSummary> {
  return paperRequest<PaperAccountSummary>("/api/paper/account/claim", {
    method: "POST",
  })
}

/** 资金流水 */
export async function getPaperLedgers(
  limit: number,
  offset: number
): Promise<{ total: number; items: PaperLedgerItem[] }> {
  return paperRequest<{ total: number; items: PaperLedgerItem[] }>(
    `/api/paper/ledgers?limit=${limit}&offset=${offset}`
  )
}

/** 委托列表 */
export async function getPaperOrders(
  status: string | null,
  limit: number,
  offset: number
): Promise<{ total: number; items: PaperOrderItem[] }> {
  const qs = new URLSearchParams()
  qs.set("limit", String(limit))
  qs.set("offset", String(offset))
  if (status) {
    qs.set("status", status)
  }
  return paperRequest<{ total: number; items: PaperOrderItem[] }>(
    `/api/paper/orders?${qs.toString()}`
  )
}

/** 模拟下单 */
export async function placePaperOrder(
  body: PlacePaperOrderRequest
): Promise<PaperOrderItem> {
  return paperRequest<PaperOrderItem>("/api/paper/orders", {
    method: "POST",
    body: JSON.stringify(body),
  })
}

/** 撤单 */
export async function cancelPaperOrder(orderId: string): Promise<PaperOrderItem> {
  return paperRequest<PaperOrderItem>(`/api/paper/orders/${orderId}`, {
    method: "DELETE",
  })
}

/** 持仓列表 */
export async function getPaperPositions(): Promise<{
  total: number
  total_margin: number
  items: PaperPositionItem[]
}> {
  return paperRequest("/api/paper/positions")
}

/** 用户交易参数 */
export interface PaperTradeSettings {
  margin_scale: number
  fee_scale: number
  margin_rate_override: number | null
  fee_mode_override: string | null
  open_fee_override: number | null
  close_fee_override: number | null
  updated_at: string | null
}

/** 品种默认规格 */
export interface ProductSpecItem {
  code: string
  name: string
  multiplier: number
  margin_rate: number
  fee_mode: string
  open_fee: number
  close_fee: number
  description: string
  /** 最小变动价位（rb=1, cu=10, au=0.02） */
  tick_size: number
  /** 价格显示小数位（tick>=1 为 0，au=0.02 为 2） */
  decimal_places: number
}

/** 读取用户交易参数 */
export async function getPaperSettings(): Promise<PaperTradeSettings> {
  return paperRequest<PaperTradeSettings>("/api/paper/settings")
}

/** 更新用户交易参数 */
export async function updatePaperSettings(body: {
  margin_scale?: number | null
  fee_scale?: number | null
  margin_rate_override?: number | null
  fee_mode_override?: string | null
  open_fee_override?: number | null
  close_fee_override?: number | null
  clear_overrides?: boolean
}): Promise<PaperTradeSettings> {
  return paperRequest<PaperTradeSettings>("/api/paper/settings", {
    method: "PUT",
    body: JSON.stringify(body),
  })
}

/** 品种默认规格列表 */
export async function getProductSpecs(): Promise<{ items: ProductSpecItem[] }> {
  return paperRequest<{ items: ProductSpecItem[] }>("/api/paper/product-specs")
}

/** 预估保证金/手续费 */
export async function estimatePaperOrder(body: {
  symbol: string
  price: number
  quantity: number
  offset: "open" | "close"
}): Promise<{
  margin: number
  fee: number
  total_needed: number
  multiplier: number
  margin_rate: number
  fee_mode: string
  fee_value: number
  notional: number
}> {
  return paperRequest("/api/paper/estimate", {
    method: "POST",
    body: JSON.stringify(body),
  })
}
