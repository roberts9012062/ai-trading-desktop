/** 商城 / VIP API 客户端 */

const API_BASE = (process.env.NEXT_PUBLIC_API_URL ?? "").replace(/\/$/, "")

async function mallRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const token =
    typeof window !== "undefined" ? localStorage.getItem("access_token") : null
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...((init?.headers as Record<string, string>) ?? {}),
  }
  if (token) headers["Authorization"] = `Bearer ${token}`
  const resp = await fetch(`${API_BASE}${path}`, { ...init, headers })
  if (resp.status === 401 && typeof window !== "undefined") {
    window.location.href = "/login"
    throw new Error("认证过期")
  }
  if (!resp.ok) {
    const error = await resp.json().catch(() => ({ detail: "请求失败" }))
    const detail = error?.detail
    throw new Error(
      typeof detail === "string" ? detail : `请求失败: ${resp.status}`
    )
  }
  return resp.json() as Promise<T>
}

export const VIP_FEATURE_LABELS: Record<string, string> = {
  ai_trading: "AI 交易",
  trading: "交易",
  backtest: "历史回测",
  factor_lab: "因子实验室",
  factor_mining: "超级因子挖掘",
}

export interface VipPlan {
  id: string
  name: string
  duration_days: number
  price: number
  features: string[]
  feature_labels: string[]
  description: string
  is_active: boolean
  sort: number
}

export interface VipMembershipState {
  is_vip: boolean
  is_admin?: boolean
  expires_at: string | null
  days_left: number
  features: string[]
  feature_labels: string[]
  daily_limits: {
    backtest: number | null
    factor_lab: number | null
    factor_mining: number | null
  }
}

export interface VipOrderItem {
  id: string
  plan_name: string
  price: number
  duration_days: number
  features: string[]
  feature_labels: string[]
  status: "pending" | "paid" | "cancelled"
  paid_at: string | null
  created_at: string
}

export async function getPlansApi(): Promise<VipPlan[]> {
  const res = await mallRequest<{ items: VipPlan[] }>("/api/mall/plans")
  return res.items
}

/** 商城状态：closed=true 时商城入口隐藏、页面显示关闭占位 */
export async function getMallStatusApi(): Promise<{ closed: boolean }> {
  return mallRequest<{ closed: boolean }>("/api/mall/status")
}

export async function getMembershipApi(): Promise<VipMembershipState> {
  return mallRequest<VipMembershipState>("/api/mall/membership")
}

export async function getMyOrdersApi(): Promise<VipOrderItem[]> {
  const res = await mallRequest<{ items: VipOrderItem[] }>("/api/mall/orders")
  return res.items
}

export async function createOrderApi(planId: string): Promise<VipOrderItem> {
  return mallRequest<VipOrderItem>("/api/mall/orders", {
    method: "POST",
    body: JSON.stringify({ plan_id: planId }),
  })
}

export async function payOrderApi(orderId: string): Promise<VipOrderItem> {
  return mallRequest<VipOrderItem>(`/api/mall/orders/${orderId}/pay`, {
    method: "POST",
  })
}

export async function cancelOrderApi(orderId: string): Promise<VipOrderItem> {
  return mallRequest<VipOrderItem>(`/api/mall/orders/${orderId}/cancel`, {
    method: "POST",
  })
}

// ---------- 管理端 ----------

export interface AdminDailyLimits {
  backtest_daily: number
  factor_lab_daily: number
  factor_mining_daily: number
  max_tasks: number
}

export async function adminGetDailyLimitsApi(): Promise<AdminDailyLimits> {
  return mallRequest<AdminDailyLimits>("/api/admin/vip/daily-limits")
}

export async function adminSetDailyLimitsApi(
  body: AdminDailyLimits
): Promise<AdminDailyLimits> {
  return mallRequest<AdminDailyLimits>("/api/admin/vip/daily-limits", {
    method: "POST",
    body: JSON.stringify(body),
  })
}

export async function adminListPlansApi(): Promise<VipPlan[]> {
  const res = await mallRequest<{ items: VipPlan[] }>("/api/admin/vip/plans")
  return res.items
}

export async function adminUpsertPlanApi(payload: {
  id?: string | null
  name: string
  duration_days: number
  price: number
  features: string[]
  description: string
  is_active: boolean
  sort: number
}): Promise<VipPlan> {
  return mallRequest<VipPlan>("/api/admin/vip/plans/upsert", {
    method: "POST",
    body: JSON.stringify({ id: payload.id ?? null, ...payload }),
  })
}

export async function adminDeletePlanApi(planId: string): Promise<void> {
  await mallRequest(`/api/admin/vip/plans/${planId}/delete`, { method: "POST" })
}

export async function adminGrantApi(payload: {
  username: string
  plan_id?: string | null
  duration_days?: number
  features?: string[]
}): Promise<VipMembershipState> {
  return mallRequest<VipMembershipState>("/api/admin/vip/grant", {
    method: "POST",
    body: JSON.stringify({
      plan_id: payload.plan_id ?? null,
      duration_days: payload.duration_days ?? 0,
      features: payload.features ?? [],
      username: payload.username,
    }),
  })
}

export async function adminRevokeApi(username: string): Promise<void> {
  await mallRequest("/api/admin/vip/revoke", {
    method: "POST",
    body: JSON.stringify({ username }),
  })
}

export async function adminListOrdersApi(): Promise<VipOrderItem[]> {
  const res = await mallRequest<{ items: VipOrderItem[] }>("/api/admin/vip/orders")
  return res.items
}
