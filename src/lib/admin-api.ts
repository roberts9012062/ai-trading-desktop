/** 管理后台 API 客户端 —— 用户 CRUD、系统设置、用户交易/AI 查看 */

const API_BASE = (process.env.NEXT_PUBLIC_API_URL ?? "").replace(/\/$/, "")

/** 通用请求（复用 token 与错误处理） */
async function adminRequest<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const token =
    typeof window !== "undefined" ? localStorage.getItem("access_token") : null
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...((options.headers as Record<string, string>) ?? {}),
  }
  if (token) {
    headers.Authorization = `Bearer ${token}`
  }

  const response = await fetch(`${API_BASE}${path}`, { ...options, headers })
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
    const err = new Error(detailText)
    ;(err as Error & { status?: number }).status = response.status
    throw err
  }
  if (response.status === 204) {
    return undefined as T
  }
  return response.json()
}

// ---------- 运维告警事件流 ----------

/** 运维告警事件（行情链路健康，来自 /api/admin/ops-alerts） */
export interface OpsAlert {
  id: string
  ts: number
  level: "info" | "warning" | "error" | "critical"
  /** 事件源：simnow_fallback / bridge_self_heal / channel_switch / bridge_down */
  source: string
  title: string
  detail?: unknown
}

/** 拉取最近 200 条运维告警（最新在前） */
export async function getOpsAlertsApi(): Promise<OpsAlert[]> {
  const data = await adminRequest<{ alerts: OpsAlert[] }>("/api/admin/ops-alerts")
  return data.alerts ?? []
}

// ---------- 类型 ----------

export interface SystemSettings {
  registration_enabled: boolean
  daily_register_limit: number
  register_reset_hour: number
  paper_claim_amount: number
  paper_claim_period: "monthly" | "daily"
  paper_claim_reset_hour: number
  paper_total_claim_cap: number
  system_name: string
  /** 实时行情渠道 */
  market_data_channel:
    | "sina"
    | "real_ctp"
    | "openctp_724"
    | "openctp_sim"
    | "vvtr"
  /** 备用渠道（主故障时切换，仅非 7×24 真实数据源） */
  backup_channel: "sina" | "real_ctp" | "openctp_sim" | "vvtr"
  /** 是否启用主备自动切换（恢复后自动回切主） */
  channel_auto_switch: boolean
  /** [已弃用] 旧版轮询开关，新代码用 kline_primary_source/backup */
  kline_source_mode: boolean
  /** [已弃用] 旧版启用列表（逗号分隔）：sina/tqsdk/eastmoney */
  kline_source_order: string
  /** K 线历史源主渠道（单源）：sina/tqsdk/eastmoney/simnow/vvtr。K 线全部走主渠道 */
  kline_primary_source: "sina" | "tqsdk" | "eastmoney" | "simnow" | "vvtr"
  /** K 线历史源备用渠道列表（逗号分隔，主渠道故障时按序降级） */
  kline_backup_sources: string
  /** K线定时修正开关：true=自动修正，false=关闭 */
  kline_sync_enabled: boolean
  /** 用量配额全局默认（0=不限；per-user 覆盖优先） */
  max_tasks_per_user: number
  factor_lab_daily_limit: number
  backtest_daily_limit: number
  /** 交易时段行情/K线/WS 刷新间隔默认秒数（1-10，默认 1） */
  market_refresh_interval_sec: number
  /** per-channel 刷新间隔覆盖 {channel: seconds}，未列渠道用默认 */
  market_refresh_intervals: Record<string, number>
  /** ----- VVTR 数据源 ----- */
  /** VVTR 总开关（false 时桥休眠，渠道回落 sina） */
  vvtr_enabled: boolean
  /** apiKey 脱敏回显（前4后4；空=未配置） */
  vvtr_api_key_masked: string
  /** 是否已配置 apiKey */
  vvtr_api_key_set: boolean
  /** VVTR 账号手机号（/my/permissions 权限查询用） */
  vvtr_mobile: string
  /** VVTR REST 基础URL */
  vvtr_base_url: string
  /** VVTR 深度行情 WS 地址 */
  vvtr_ws_url: string
  /** VVTR 实时行情开关（报价/盘口/成交） */
  vvtr_quotes_enabled: boolean
  /** VVTR WSS 推送开关：开=尝试WS自动降级HTTP，关=仅HTTP快照轮询 */
  vvtr_ws_enabled: boolean
  /** VVTR 历史K线源开关 */
  vvtr_kline_enabled: boolean
  updated_at: string | null
}

/** 单用户配额（覆盖值 + 生效额度 + 当日已用） */
export interface UserQuota {
  max_tasks_override: number | null
  factor_lab_daily_override: number | null
  backtest_daily_override: number | null
  effective: {
    max_tasks: number | null
    factor_daily: number | null
    backtest_daily: number | null
  }
  used: {
    tasks: number
    factor_today: number
    backtest_today: number
  }
}

export interface RegistrationStatus {
  registration_enabled: boolean
  daily_register_limit: number
  register_reset_hour: number
  registered_in_window: number
  remaining: number | null
  can_register: boolean
  reason: string
  system_name: string
  window_start: string
}

export interface AdminUserItem {
  id: string
  username: string
  phone: string | null
  email: string | null
  avatar: string | null
  real_name_verified: boolean
  role: "user" | "admin"
  status: "active" | "frozen"
  created_at: string
  updated_at: string
  /** 兼容：默认实盘权益 */
  risk_rate: number
  total_equity: number
  total_claimed: number
  /** 双盘权益（列表并排） */
  live_equity?: number
  virtual_equity?: number
  live_risk_rate?: number
  virtual_risk_rate?: number
}

export interface AdminUserListResponse {
  total: number
  items: AdminUserItem[]
}

export interface AdminUserOverview {
  user: AdminUserItem
  paper_account: Record<string, unknown>
  ai_task_stats: {
    total: number
    running: number
    paused: number
    stopped: number
    by_status: Record<string, number>
  }
}

export interface AdminCreateUserBody {
  username: string
  password: string
  phone?: string | null
  email?: string | null
  role?: "user" | "admin"
  status?: "active" | "frozen"
}

export interface AdminUpdateUserBody {
  phone?: string | null
  email?: string | null
  role?: "user" | "admin"
  status?: "active" | "frozen"
  password?: string | null
  clear_phone?: boolean
  clear_email?: boolean
  /** per-user 配额覆盖；传值=覆盖，传 null=清除回退全局默认 */
  max_tasks_override?: number | null
  factor_lab_daily_override?: number | null
  backtest_daily_override?: number | null
}

// ---------- 公开 / 系统设置 ----------

/** 公开：注册状态（无需登录） */
export async function getRegistrationStatusApi(): Promise<RegistrationStatus> {
  const response = await fetch(`${API_BASE}/api/auth/registration-status`)
  if (!response.ok) {
    throw new Error("获取注册状态失败")
  }
  return response.json()
}

export async function getAdminSettingsApi(): Promise<SystemSettings> {
  return adminRequest<SystemSettings>("/api/admin/settings")
}

export async function updateAdminSettingsApi(
  body: Partial<SystemSettings>,
): Promise<SystemSettings> {
  return adminRequest<SystemSettings>("/api/admin/settings", {
    method: "PUT",
    body: JSON.stringify(body),
  })
}

// ---------- 渠道监控 ----------

/** 单渠道健康状态 */
export interface ChannelHealth {
  status: "green" | "orange" | "red"
  channel: string
  age_sec: number | null
  last_price: number | null
  trade_date: string | null
  reason?: string
}

/** GET /api/admin/channels/status 响应 */
export interface ChannelStatusResponse {
  active: string
  primary: string
  backup: string
  auto_switch: boolean
  channels: Record<string, ChannelHealth>
}

/** 重启渠道 bridge 结果 */
export interface ChannelRestartResult {
  ok: boolean
  channel: string
  container: string | null
  detail: string
}

/** 备用渠道候选（非 7×24 真实数据源，主渠道故障时切换） */
export const REALTIME_CHANNEL_OPTIONS: { value: string; label: string }[] = [
  { value: "sina", label: "新浪 sina（HTTP，最稳）" },
  { value: "vvtr", label: "VVTR（WS 深度行情，5 档）" },
  { value: "real_ctp", label: "真实 CTP（期货公司）" },
  { value: "openctp_sim", label: "openctp 仿真" },
]

/** 主渠道候选（全部渠道；SimNow 已下线） */
export const ALL_CHANNEL_OPTIONS: { value: string; label: string }[] = [
  { value: "sina", label: "sina（新浪 HTTP）" },
  { value: "vvtr", label: "vvtr（VVTR WS 深度行情）" },
  { value: "real_ctp", label: "real_ctp（期货公司 CTP）" },
  { value: "openctp_724", label: "openctp_724（7×24）" },
  { value: "openctp_sim", label: "openctp_sim（仿真）" },
]

export async function getChannelStatusApi(): Promise<ChannelStatusResponse> {
  return adminRequest<ChannelStatusResponse>("/api/admin/channels/status")
}

export async function restartChannelApi(
  channel: string,
): Promise<ChannelRestartResult> {
  return adminRequest<ChannelRestartResult>(
    `/api/admin/channels/${channel}/restart`,
    { method: "POST" },
  )
}

// ---------- K 线历史数据源状态 ----------

/** 单个 K 线源健康状态 */
export interface KlineSourceHealth {
  status: "green" | "orange" | "red"
  source: string
  /** 探测响应耗时（毫秒） */
  latency_ms: number | null
  /** 是否返回了有效 bar */
  has_data: boolean
  /** 最近 bar 日期 */
  last_bar_date: string | null
  /** 运行时连续失败次数 */
  fails: number
  /** 是否处于冷却中 */
  in_cooldown: boolean
  /** red 时的原因 */
  reason?: string | null
}

/** GET /api/admin/kline-sources/status 响应 */
export interface KlineSourceStatusResponse {
  primary: string
  backups: string[]
  sources: Record<string, KlineSourceHealth>
}

export async function getKlineSourceStatusApi(): Promise<KlineSourceStatusResponse> {
  return adminRequest<KlineSourceStatusResponse>(
    "/api/admin/kline-sources/status",
  )
}

// ---------- K 线修正任务状态 ----------

/** 单个品种的修正日志 */
export interface KlineSyncLogEntry {
  ts: string
  code: string
  symbol: string
  elapsed_sec: number
  status: "ok" | "error"
  periods: Record<string, {
    written: number
    verified: number
    single: number
    conflict: number
    skipped: number
    error?: boolean
  }>
  errors?: string[]
}

/** 修正任务汇总状态 */
export interface KlineSyncStatus {
  status: "running" | "completed" | "completed_with_errors" | "failed"
  trigger: string
  started_at: string | null
  finished_at: string | null
  duration_sec: number | null
  total_codes: number
  processed: number
  stats: Record<string, number>
  errors: string[]
  last_run: string | null
}

export interface KlineSyncStatusResponse {
  status: KlineSyncStatus
  logs: KlineSyncLogEntry[]
}

export async function getKlineSyncStatusApi(): Promise<KlineSyncStatusResponse> {
  return adminRequest<KlineSyncStatusResponse>(
    "/api/admin/kline-sync/status",
  )
}

// ---------- K 线修正任务组 ----------

/** K 线修正组任务(后端 KLINE_TASKS 注册表聚合) */
export interface KlineTask {
  name: string
  label: string
  interval_desc: string
  pausable: boolean
  runnable: boolean
  paused: boolean
  status: {
    running?: boolean
    paused?: boolean
    disabled?: boolean
    last_start?: string | null
    last_done?: string | null
    last_error?: string | null
    last_corrected?: number
    last_written?: number
    last_stats?: Record<string, unknown>
    trigger?: string
  }
}

export interface KlineTasksResponse {
  tasks: KlineTask[]
}

export interface KlineTaskLogsResponse {
  name: string
  logs: Array<Record<string, unknown> & { ts?: string; level?: string; msg?: string }>
}

export async function getKlineTasksApi(): Promise<KlineTasksResponse> {
  return adminRequest<KlineTasksResponse>("/api/admin/kline-tasks")
}

export async function pauseKlineTaskApi(name: string): Promise<void> {
  await adminRequest(`/api/admin/kline-tasks/${name}/pause`, { method: "POST" })
}

export async function resumeKlineTaskApi(name: string): Promise<void> {
  await adminRequest(`/api/admin/kline-tasks/${name}/resume`, { method: "POST" })
}

export async function runKlineTaskApi(name: string): Promise<void> {
  await adminRequest(`/api/admin/kline-tasks/${name}/run`, { method: "POST" })
}

export async function getKlineTaskLogsApi(
  name: string,
  limit = 100,
): Promise<KlineTaskLogsResponse> {
  return adminRequest<KlineTaskLogsResponse>(
    `/api/admin/kline-tasks/${name}/logs?limit=${limit}`,
  )
}

// ---------- 仪表盘聚合 ----------

export interface OverviewChannels {
  active: string
  channels: Record<string, ChannelHealth>
}
export interface OverviewSystem {
  containers: Record<string, string>
  redis: boolean
  postgres: boolean
}
export interface OverviewAi {
  by_mode: Record<string, Record<string, { count: number; capital: number }>>
  running: number
  total: number
  allocated_capital: number
}
export interface OverviewUsers {
  total_users: number
  today_new: number
  by_mode: Record<string, { accounts: number; equity: number }>
  total_equity: number
}
export interface AdminOverview {
  channels: OverviewChannels
  system: OverviewSystem
  ai: OverviewAi
  users: OverviewUsers
}

export async function getAdminOverviewApi(): Promise<AdminOverview> {
  return adminRequest<AdminOverview>("/api/admin/overview")
}

// ---------- 用户 ----------

export async function listAdminUsersApi(params: {
  keyword?: string
  status?: string
  role?: string
  limit?: number
  offset?: number
}): Promise<AdminUserListResponse> {
  const q = new URLSearchParams()
  if (params.keyword) q.set("keyword", params.keyword)
  if (params.status) q.set("status", params.status)
  if (params.role) q.set("role", params.role)
  q.set("limit", String(params.limit ?? 20))
  q.set("offset", String(params.offset ?? 0))
  return adminRequest<AdminUserListResponse>(`/api/admin/users?${q.toString()}`)
}

export async function createAdminUserApi(
  body: AdminCreateUserBody,
): Promise<AdminUserItem> {
  return adminRequest<AdminUserItem>("/api/admin/users", {
    method: "POST",
    body: JSON.stringify(body),
  })
}

export type AdminTradingMode = "live" | "virtual"

export async function getAdminUserOverviewApi(
  userId: string,
  tradingMode: AdminTradingMode = "live",
): Promise<AdminUserOverview> {
  const q = new URLSearchParams({ trading_mode: tradingMode })
  return adminRequest<AdminUserOverview>(
    `/api/admin/users/${userId}?${q.toString()}`,
  )
}

export async function updateAdminUserApi(
  userId: string,
  body: AdminUpdateUserBody,
): Promise<AdminUserItem> {
  return adminRequest<AdminUserItem>(`/api/admin/users/${userId}`, {
    method: "PUT",
    body: JSON.stringify(body),
  })
}

export async function getUserQuotaApi(userId: string): Promise<UserQuota> {
  return adminRequest<UserQuota>(`/api/admin/users/${userId}/quota`)
}

export async function deleteAdminUserApi(
  userId: string,
): Promise<{ message: string; id: string }> {
  return adminRequest(`/api/admin/users/${userId}`, { method: "DELETE" })
}

export async function getAdminUserOrdersApi(
  userId: string,
  params: {
    status?: string
    limit?: number
    offset?: number
    tradingMode?: AdminTradingMode
  },
): Promise<{ total: number; items: Record<string, unknown>[] }> {
  const q = new URLSearchParams()
  if (params.status) q.set("status", params.status)
  q.set("limit", String(params.limit ?? 50))
  q.set("offset", String(params.offset ?? 0))
  q.set("trading_mode", params.tradingMode ?? "live")
  return adminRequest(`/api/admin/users/${userId}/orders?${q.toString()}`)
}

export async function getAdminUserPositionsApi(
  userId: string,
  tradingMode: AdminTradingMode = "live",
): Promise<{ total: number; items: Record<string, unknown>[] }> {
  const q = new URLSearchParams({ trading_mode: tradingMode })
  return adminRequest(`/api/admin/users/${userId}/positions?${q.toString()}`)
}

export async function getAdminUserAiTasksApi(
  userId: string,
  tradingMode: AdminTradingMode = "live",
): Promise<{ total: number; items: Record<string, unknown>[] }> {
  const q = new URLSearchParams({
    limit: "50",
    trading_mode: tradingMode,
  })
  return adminRequest(`/api/admin/users/${userId}/ai-tasks?${q.toString()}`)
}

export async function getAdminUserAiDecisionsApi(
  userId: string,
  taskId?: string,
  tradingMode: AdminTradingMode = "live",
): Promise<{ total: number; items: Record<string, unknown>[] }> {
  const q = new URLSearchParams({
    limit: "50",
    trading_mode: tradingMode,
  })
  if (taskId) q.set("task_id", taskId)
  return adminRequest(
    `/api/admin/users/${userId}/ai-decisions?${q.toString()}`,
  )
}

export interface AdminRunLog {
  id: string
  task_id: string
  bar_time: string | null
  timeframe: string
  symbol: string
  strategy_type: string
  level: "info" | "warn" | "error"
  event: string
  action: string
  order_id: string | null
  reason: string
  detail: Record<string, unknown> | null
  created_at: string
}

export async function getAdminUserRunLogsApi(
  userId: string,
  opts?: {
    taskId?: string
    level?: string
    event?: string
    tradingMode?: AdminTradingMode
  },
): Promise<{ total: number; items: AdminRunLog[] }> {
  const q = new URLSearchParams({ limit: "100" })
  if (opts?.taskId) q.set("task_id", opts.taskId)
  if (opts?.level) q.set("level", opts.level)
  if (opts?.event) q.set("event", opts.event)
  q.set("trading_mode", opts?.tradingMode ?? "live")
  return adminRequest(`/api/admin/users/${userId}/run-logs?${q.toString()}`)
}

export async function getAdminUserPnlApi(
  userId: string,
  tradingMode: AdminTradingMode = "live",
): Promise<Record<string, unknown>> {
  const q = new URLSearchParams({ trading_mode: tradingMode })
  return adminRequest(`/api/admin/users/${userId}/pnl?${q.toString()}`)
}

// ---------- API Key（对外展示站对接）----------

/** 单个 API Key（列表项；raw_key 仅创建/重置时返回） */
export interface ApiKeyItem {
  id: string
  name: string
  key_prefix: string
  key_preview: string
  is_active: boolean
  last_used_at: string | null
  created_at: string
  updated_at: string
  /** 明文 Key，仅在创建/重置的响应里返回一次；列表接口为 null */
  raw_key?: string | null
}

export async function listApiKeysApi(): Promise<{
  total: number
  items: ApiKeyItem[]
}> {
  return adminRequest("/api/admin/api-keys")
}

export async function createApiKeyApi(name: string): Promise<ApiKeyItem> {
  return adminRequest<ApiKeyItem>("/api/admin/api-keys", {
    method: "POST",
    body: JSON.stringify({ name }),
  })
}

export async function updateApiKeyApi(
  id: string,
  body: { name?: string; is_active?: boolean },
): Promise<ApiKeyItem> {
  return adminRequest<ApiKeyItem>(`/api/admin/api-keys/${id}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  })
}

export async function rotateApiKeyApi(id: string): Promise<ApiKeyItem> {
  return adminRequest<ApiKeyItem>(`/api/admin/api-keys/${id}/rotate`, {
    method: "POST",
  })
}

export async function deleteApiKeyApi(
  id: string,
): Promise<{ deleted: boolean; id: string }> {
  return adminRequest(`/api/admin/api-keys/${id}`, { method: "DELETE" })
}

// ---------- VVTR 数据源 ----------

/** VVTR 套餐条目（/my/permissions） */
export interface VvtrPackage {
  name: string | null
  market_code: string | null
  market_name: string | null
  limit: number | null
  expire_time: string | null
  days_left: number | null
}

/** POST /api/admin/vvtr/test 响应 */
export interface VvtrTestResult {
  ok: boolean
  code: number | null
  msg: string
  packages: VvtrPackage[]
  apis: string[]
}

/** 测试 VVTR 连接（可先填密钥试连再保存；留空则用已存密钥） */
export async function testVvtrConnectionApi(body: {
  api_key?: string
  mobile?: string
}): Promise<VvtrTestResult> {
  return adminRequest<VvtrTestResult>("/api/admin/vvtr/test", {
    method: "POST",
    body: JSON.stringify(body),
  })
}

/** 保存 VVTR 配置（apiKey 留空=不修改；明文只在保存请求中出现一次） */
export async function updateVvtrSettingsApi(body: {
  vvtr_enabled?: boolean
  vvtr_api_key?: string
  vvtr_api_key_clear?: boolean
  vvtr_mobile?: string
  vvtr_base_url?: string
  vvtr_ws_url?: string
  vvtr_quotes_enabled?: boolean
  vvtr_ws_enabled?: boolean
  vvtr_kline_enabled?: boolean
}): Promise<SystemSettings> {
  return adminRequest<SystemSettings>("/api/admin/settings", {
    method: "PUT",
    body: JSON.stringify(body),
  })
}
