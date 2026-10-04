import type { AuthResponse, LoginRequest, RegisterRequest, User, NewsItem, ArticleContent, AIProvider, AIModel, PresetProvider, ProviderTestResult, AIConversationItem, AIMessagePage, MarketplaceSkillItem, MarketplaceSkillDetail, InstalledSkillItem, SkillConfig, CodeTreeMap, Message, MessageCategory, PriceAlert, NotifySetting } from "@/types"
import type { IndicatorConfig } from "@/types/indicator"
import type { KlineBar } from "@/types"
import { getBinanceKlineApi } from "@/lib/binance-kline"
import type { ProfitLockTemplate } from "@/lib/profit-lock-templates"
import type { ProfitLockConfig } from "@/lib/ai-trading-api"

export function listProfitLockTemplates(): Promise<ProfitLockTemplate[]> {
  return request("/api/profit-lock-templates")
}
export function saveProfitLockTemplate(body: { name: string; config: ProfitLockConfig }, id?: string): Promise<ProfitLockTemplate> {
  return request(`/api/profit-lock-templates${id ? `/${encodeURIComponent(id)}` : ""}`, {
    method: id ? "PUT" : "POST", body: JSON.stringify(body),
  })
}
export function deleteProfitLockTemplate(id: string): Promise<{ deleted: boolean }> {
  return request(`/api/profit-lock-templates/${encodeURIComponent(id)}`, { method: "DELETE" })
}

// 空字符串 = 同域（Next rewrites /api → BACKEND_URL），避免 localhost↔127.0.0.1 CORS
// 生产可设 NEXT_PUBLIC_API_URL 为完整后端地址
const API_BASE = (process.env.NEXT_PUBLIC_API_URL ?? "").replace(/\/$/, "")

/** 请求选项：在标准 fetch 选项上扩展 skipAuthRedirect 标记 */
interface ApiRequestOptions extends RequestInit {
  /**
   * 用于「获取凭证」类端点（登录 / 注册）：
   * 401 代表凭据错误而非 token 过期，此时直接抛出后端错误交给调用方在表单内提示，
   * 不做 token 刷新、不硬跳 /login。
   */
  skipAuthRedirect?: boolean
}

/** 通用 API 请求封装 */
async function request<T>(
  path: string,
  options: ApiRequestOptions = {}
): Promise<T> {
  const token = typeof window !== "undefined" ? localStorage.getItem("access_token") : null

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

  if (response.status === 401) {
    // 登录 / 注册等「获取凭证」端点：401 是凭据错误，交给调用方在表单内提示，
    // 不自动刷新 token、不硬跳 /login（否则用户输错密码会被整页踢回登录页）
    if (options.skipAuthRedirect === true) {
      const error = await response.json().catch(() => ({ detail: "请求失败" }))
      const detail =
        typeof error?.detail === "string"
          ? error.detail
          : `请求失败: ${response.status}`
      throw new Error(detail)
    }
    // Token 过期，尝试刷新
    const refreshed = await tryRefreshToken()
    if (refreshed) {
      headers["Authorization"] = `Bearer ${localStorage.getItem("access_token")}`
      const retryResponse = await fetch(`${API_BASE}${path}`, { ...options, headers })
      if (!retryResponse.ok) throw new Error(`请求失败: ${retryResponse.status}`)
      return retryResponse.json()
    }
    // 刷新失败，跳转登录
    if (typeof window !== "undefined") {
      localStorage.removeItem("access_token")
      localStorage.removeItem("refresh_token")
      window.location.href = "/login"
    }
    throw new Error("认证过期")
  }

  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: "请求失败" }))
    // FastAPI detail 可能是 string 或校验错误数组
    let detailText = `请求失败: ${response.status}`
    if (typeof error?.detail === "string") {
      detailText = error.detail
    } else if (Array.isArray(error?.detail)) {
      detailText = error.detail
        .map((item: { msg?: string }) => item?.msg ?? JSON.stringify(item))
        .join("; ")
    } else if (error?.message) {
      detailText = String(error.message)
    }
    const err = new Error(detailText)
    ;(err as Error & { status?: number }).status = response.status
    throw err
  }

  // 204 No Content：无响应体（DELETE 等），直接返回，避免 json() 解析空 body 抛错
  if (response.status === 204) {
    return undefined as T
  }

  return response.json()
}

/** 尝试刷新 access token（HTTP 401 / WS 4401 共用） */
export async function tryRefreshToken(): Promise<boolean> {
  const refreshToken = localStorage.getItem("refresh_token")
  if (!refreshToken) return false

  try {
    const response = await fetch(`${API_BASE}/api/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: refreshToken }),
    })
    if (!response.ok) return false

    const data = await response.json() as {
      access_token?: string
      refresh_token?: string
    }
    if (!data.access_token) {
      return false
    }
    // 同步写入 access/refresh，会话最长保持 7 天
    localStorage.setItem("access_token", data.access_token)
    if (data.refresh_token) {
      localStorage.setItem("refresh_token", data.refresh_token)
    }
    // 同步 zustand，避免内存 token 与 localStorage 不一致
    try {
      const { useAuthStore } = await import("@/stores/auth")
      useAuthStore.getState().setAccessToken(data.access_token)
    } catch {
      // store 未就绪时忽略
    }
    return true
  } catch {
    return false
  }
}

// ===== 认证 API =====

/** 登录 */
export async function loginApi(req: LoginRequest): Promise<AuthResponse> {
  return request<AuthResponse>("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({
      username: req.account,
      password: req.password,
      trading_mode: req.trading_mode ?? "live",
    }),
    // 凭据错误（401）不应触发 token 刷新/跳登录，直接把错误交给表单
    skipAuthRedirect: true,
  })
}

/** 注册（后端返回 TokenResponse，与登录一致） */
export async function registerApi(req: RegisterRequest): Promise<AuthResponse> {
  return request<AuthResponse>("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({
      username: req.username,
      password: req.password,
      phone: req.phone,
      email: req.email,
    }),
    // 注册端点同理：401/凭据冲突交由表单提示，不硬跳 /login
    skipAuthRedirect: true,
  })
}

/** 解析角色，仅 admin 视为管理员，其它一律 user */
function normalizeRole(raw: unknown): "user" | "admin" {
  const value = String(raw ?? "")
    .trim()
    .toLowerCase()
  return value === "admin" ? "admin" : "user"
}

/** 将后端用户信息规范为前端 User */
function normalizeUser(raw: Record<string, unknown>): User {
  return {
    id: String(raw.id ?? ""),
    username: String(raw.username ?? ""),
    phone: (raw.phone as string | null) ?? null,
    email: (raw.email as string | null) ?? null,
    avatar: (raw.avatar as string | null) ?? null,
    realNameVerified: Boolean(
      raw.real_name_verified ?? raw.realNameVerified ?? false,
    ),
    real_name_verified: Boolean(
      raw.real_name_verified ?? raw.realNameVerified ?? false,
    ),
    role: normalizeRole(raw.role),
    status: (raw.status as "active" | "frozen") ?? "active",
    trading_mode:
      String(raw.trading_mode ?? "live").toLowerCase() === "virtual"
        ? "virtual"
        : "live",
    createdAt: String(raw.created_at ?? raw.createdAt ?? ""),
    created_at: String(raw.created_at ?? raw.createdAt ?? ""),
    updated_at: String(raw.updated_at ?? ""),
  }
}

/** 获取当前用户 */
export async function getMeApi(): Promise<User> {
  const raw = await request<Record<string, unknown>>("/api/auth/me")
  return normalizeUser(raw)
}

/** 更新用户信息（仅允许 phone/email/avatar，禁止改 role） */
export async function updateUserApi(data: Partial<User>): Promise<User> {
  const body: Record<string, unknown> = {}
  if (data.phone !== undefined) body.phone = data.phone
  if (data.email !== undefined) body.email = data.email
  if (data.avatar !== undefined) body.avatar = data.avatar
  const raw = await request<Record<string, unknown>>("/api/users/me", {
    method: "PUT",
    body: JSON.stringify(body),
  })
  return normalizeUser(raw)
}

/** 修改密码 */
export async function changePasswordApi(oldPassword: string, newPassword: string): Promise<void> {
  await request("/api/users/me/password", {
    method: "PUT",
    body: JSON.stringify({ old_password: oldPassword, new_password: newPassword }),
  })
}

// ===== 行情 API =====

/** 合约信息（列表/搜索通用） */
export interface ContractItem {
  symbol: string
  name: string
  exchange: string
  /** 是否主力（列表接口可能返回） */
  is_master?: boolean
  is_secondary?: boolean
}

/** 合约搜索响应 */
export interface ContractSearchResult {
  contracts: ContractItem[]
  total: number
}

/** 自选记录 */
export interface WatchlistItem {
  id: string
  contract_symbol: string
  contract_name: string
  sort_order: number
  group_name: string | null
  created_at: string
  last_price: number | null
  change: number | null
  change_pct: number | null
  bid_price: number | null
  ask_price: number | null
  volume: number | null
}

/** 交易时段状态 */
export interface SessionStatus {
  symbol: string
  product_code: string
  profile: string
  profile_label: string
  is_open: boolean
  reason: string
  now_bj?: string
  weekday?: number
  sessions: Array<{ start: string; end: string; cross_midnight: boolean }>
  message: string
  market_coarse_open?: boolean
  /** live | virtual */
  trading_mode?: string
  /** virtual 盘：openctp 是否有该合约报价 */
  has_virtual_quote?: boolean | null
  last_price?: number | null
}

/** 查询合约是否处于可交易时段 */
export async function getSessionStatusApi(symbol: string): Promise<SessionStatus> {
  return request<SessionStatus>(
    `/api/market/session-status?symbol=${encodeURIComponent(symbol)}`
  )
}

/** 搜索合约 */
export async function searchContractsApi(q: string): Promise<ContractSearchResult> {
  return request<ContractSearchResult>(`/api/market/contracts/search?q=${encodeURIComponent(q)}`)
}

/** 获取全部合约列表 */
export async function getContractsApi(exchange?: string): Promise<ContractItem[]> {
  const params = exchange ? `?exchange=${encodeURIComponent(exchange)}` : ""
  return request<ContractItem[]>(`/api/market/contracts${params}`)
}

/** 按品种代码分组的合约树(含主力/次主力标记) */
export async function getContractsByCodeApi(): Promise<CodeTreeMap> {
  return request<CodeTreeMap>("/api/market/contracts/by-code")
}

/** HTTP 行情快照（侧栏/品种树首屏；实时仍靠 WebSocket） */
export async function getQuotesSnapshotApi(): Promise<
  Array<Record<string, unknown>>
> {
  return request<Array<Record<string, unknown>>>("/api/market/quotes")
}

/** 添加自选 */
export async function addWatchlistApi(
  contractSymbol: string,
  contractName: string,
): Promise<WatchlistItem> {
  return request<WatchlistItem>("/api/watchlist", {
    method: "POST",
    body: JSON.stringify({ contract_symbol: contractSymbol, contract_name: contractName }),
  })
}

/** 删除自选 */
export async function deleteWatchlistApi(id: string): Promise<void> {
  await request(`/api/watchlist/${id}`, { method: "DELETE" })
}

/** 获取自选列表 */
export async function getWatchlistApi(): Promise<WatchlistItem[]> {
  return request<WatchlistItem[]>("/api/watchlist")
}

/** 批量更新自选排序 */
export async function sortWatchlistApi(
  items: Array<{ id: string; sort_order: number }>,
): Promise<void> {
  await request("/api/watchlist/sort", {
    method: "PUT",
    body: JSON.stringify({ items }),
  })
}

// ===== K 线 API =====

/** K 线 bar 数据 */
export interface KlineBarApi {
  time: string
  open: number
  high: number
  low: number
  close: number
  volume: number
  /** 结算价（数据源不支持时为 null） */
  settle: number | null
  /** 持仓量（数据源不支持时为 null） */
  open_interest: number | null
}

/** K 线响应 */
export interface KlineResponse {
  symbol: string
  period: string
  bars: KlineBarApi[]
  has_more: boolean
}

/** K 线 bundle 响应中单个周期的数据段 */
export interface KlineBundlePeriod {
  period: string
  bars: KlineBarApi[]
  has_more: boolean
}

/** Binance bar(可选字段) → API bar(settle/open_interest 必有,加密数据源恒 null) */
function toKlineBarApi(b: KlineBar): KlineBarApi {
  return {
    time: b.time,
    open: b.open,
    high: b.high,
    low: b.low,
    close: b.close,
    volume: b.volume,
    settle: b.settle ?? null,
    open_interest: b.open_interest ?? null,
  }
}

/** K 线多周期打包响应（一次返回同合约全部分钟周期最新视图） */
export interface KlineBundleResponse {
  symbol: string
  periods: KlineBundlePeriod[]
}

/** 一次拉取同合约全部分钟周期（1m/5m/15m/30m/60m）最新视图。
 *  直连 Binance 公开行情域并发拉各周期,不经服务器转发。 */
export async function getKlineBundleApi(
  symbol: string,
  limit?: number,
): Promise<KlineBundleResponse> {
  const periods = ["1m", "5m", "15m", "30m", "60m"]
  const segs = await Promise.all(
    periods.map(async (p): Promise<KlineBundlePeriod> => {
      try {
        const page = await getBinanceKlineApi(symbol, p, { limit })
        return { period: p, bars: page.bars.map(toKlineBarApi), has_more: page.has_more }
      } catch {
        // 单周期失败归一为空(与后端 bundle 部分周期异常的语义一致,保留旧缓存)
        return { period: p, bars: [] as KlineBarApi[], has_more: false }
      }
    }),
  )
  return { symbol, periods: segs }
}

/** 获取 K 线历史数据（支持懒加载切片）。
 *  K 线周期(1m~1d)直连 Binance 公开行情域(data-api.binance.vision),不经服务器
 *  转发;tick 分时是逐笔序列,仍走后端接口。 */
export async function getKlineApi(
  symbol: string,
  period: string,
  options?: { limit?: number; endTime?: string },
): Promise<KlineResponse> {
  if (period !== "tick") {
    const page = await getBinanceKlineApi(symbol, period, options)
    return {
      symbol,
      period,
      bars: page.bars.map(toKlineBarApi),
      has_more: page.has_more,
    }
  }
  const params = new URLSearchParams({
    symbol,
    period,
  })
  if (options?.limit) params.set("limit", String(options.limit))
  if (options?.endTime) params.set("end_time", options.endTime)
  return request<KlineResponse>(`/api/market/kline?${params}`)
}

// ===== 新闻 API =====

/** 获取最新全量新闻（最近 20 条） */
export async function getLatestNews(): Promise<NewsItem[]> {
  return request<NewsItem[]>("/api/news/latest")
}

/** 获取品种关联新闻（最近 50 条） */
export async function getContractNews(symbol: string): Promise<NewsItem[]> {
  return request<NewsItem[]>(`/api/news/${encodeURIComponent(symbol)}`)
}

/** 获取文章正文内容 */
export async function getNewsArticle(url: string): Promise<ArticleContent> {
  return request<ArticleContent>(`/api/news/article?url=${encodeURIComponent(url)}`)
}

// ===== AI 渠道管理 API =====

/** 获取预设渠道列表 */
export async function getPresetProviders(): Promise<PresetProvider[]> {
  return request<PresetProvider[]>("/api/ai/providers/presets")
}

/** 获取用户渠道列表 */
export async function getAIProviders(): Promise<AIProvider[]> {
  return request<AIProvider[]>("/api/ai/providers")
}

/** 添加渠道 */
export async function createAIProvider(data: {
  name: string
  api_type: string
  base_url: string
  api_key: string
  thinking_enabled?: boolean | null
}): Promise<AIProvider> {
  return request<AIProvider>("/api/ai/providers", {
    method: "POST",
    body: JSON.stringify(data),
  })
}

/** 更新渠道（api_key 可选：省略/空字符串表示不改密钥） */
export async function updateAIProvider(
  id: string,
  data: {
    name?: string
    api_type?: string
    base_url?: string
    api_key?: string
    is_active?: boolean
    /** 显式 null 表示恢复「跟随模型自动」；省略表示不改动 */
    thinking_enabled?: boolean | null
  },
): Promise<AIProvider> {
  return request<AIProvider>(`/api/ai/providers/${id}`, {
    method: "PUT",
    body: JSON.stringify(data),
  })
}

/** 删除渠道 */
export async function deleteAIProvider(id: string): Promise<void> {
  await request(`/api/ai/providers/${id}`, { method: "DELETE" })
}

/** 测试渠道连通性 */
export async function testAIProvider(id: string): Promise<ProviderTestResult> {
  return request<ProviderTestResult>(`/api/ai/providers/${id}/test`, { method: "POST" })
}

// ===== AI 模型库 API =====

/** 获取用户模型库 */
export async function getAIModels(): Promise<AIModel[]> {
  return request<AIModel[]>("/api/ai/models")
}

/** 从渠道批量添加模型 */
export async function batchCreateAIModels(
  providerId: string,
  models: Array<{
    model_id: string
    display_name: string
    is_multimodal: boolean
    is_custom: boolean
    capabilities: string[]
  }>,
): Promise<AIModel[]> {
  return request<AIModel[]>(`/api/ai/models/providers/${providerId}`, {
    method: "POST",
    body: JSON.stringify({ models }),
  })
}

/** 更新模型 */
export async function updateAIModel(id: string, data: { display_name: string }): Promise<AIModel> {
  return request<AIModel>(`/api/ai/models/${id}`, {
    method: "PUT",
    body: JSON.stringify(data),
  })
}

/** 删除模型 */
export async function deleteAIModel(id: string): Promise<void> {
  await request(`/api/ai/models/${id}`, { method: "DELETE" })
}

// ===== AI 对话历史 API =====

/** 创建新对话 */
export async function createConversation(modelId: string): Promise<AIConversationItem> {
  return request<AIConversationItem>("/api/ai/conversations", {
    method: "POST",
    body: JSON.stringify({ model_id: modelId }),
  })
}

/** 获取对话列表 */
export async function getConversations(): Promise<AIConversationItem[]> {
  return request<AIConversationItem[]>("/api/ai/conversations")
}

/** 删除对话 */
export async function deleteConversation(id: string): Promise<void> {
  await request(`/api/ai/conversations/${id}`, { method: "DELETE" })
}

/** 获取对话消息（分页） */
export async function getConversationMessages(
  id: string,
  page: number,
  size: number,
): Promise<AIMessagePage> {
  return request<AIMessagePage>(
    `/api/ai/conversations/${id}/messages?page=${page}&size=${size}`,
  )
}

// ===== AI 知识库 API =====

/** 知识库上传响应 */
export interface KnowledgeUploadResult {
  ok: boolean
  document_id: string
  filename: string
  chunks: number
  vectorized: number
}

/** 上传文档到知识库 */
export async function uploadKnowledgeDocument(file: File): Promise<KnowledgeUploadResult> {
  const token = typeof window !== "undefined" ? localStorage.getItem("access_token") : null
  const formData = new FormData()
  formData.append("file", file)

  const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000"
  const response = await fetch(`${API_BASE}/api/ai/knowledge/upload`, {
    method: "POST",
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: formData,
  })

  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: "上传失败" }))
    throw new Error(error.detail ?? `上传失败: ${response.status}`)
  }

  return response.json()
}

// ===== AI 知识库文档管理 API =====

/** 知识库文档条目 */
export interface KnowledgeDocument {
  document_id: string
  document_name: string
  chunk_count: number
}

/** 获取知识库文档列表 */
export async function getKnowledgeDocuments(): Promise<KnowledgeDocument[]> {
  return request<KnowledgeDocument[]>("/api/ai/knowledge/documents")
}

/** 删除知识库文档 */
export async function deleteKnowledgeDocument(documentId: string): Promise<void> {
  await request<void>(`/api/ai/knowledge/documents/${documentId}`, { method: "DELETE" })
}

// ===== AI 记忆管理 API =====

/** AI 记忆条目 */
export interface AIMemoryItem {
  id: string
  type: string
  title: string
  summary: string
  created_at: string
}

/** AI 偏好条目 */
export interface AIPreferenceItem {
  id: string
  type: string
  category: string
  preference: string
  created_at: string
}

/** AI 记忆列表响应 */
export interface AIMemoryListResponse {
  memories: AIMemoryItem[]
  preferences: AIPreferenceItem[]
}

/** 获取 AI 记忆列表 */
export async function getAIMemories(): Promise<AIMemoryListResponse> {
  return request<AIMemoryListResponse>("/api/ai/memory")
}

/** 删除长期记忆 */
export async function deleteAIMemory(memoryId: string): Promise<void> {
  await request<void>(`/api/ai/memory/memories/${memoryId}`, { method: "DELETE" })
}

/** 删除用户偏好 */
export async function deleteAIPreference(prefId: string): Promise<void> {
  await request<void>(`/api/ai/memory/preferences/${prefId}`, { method: "DELETE" })
}

// ===== AI 工具箱 =====

/** 内置 AI 工具目录项 */
export interface AIToolItem {
  name: string
  name_zh: string
  description_zh: string
  category: string
  requires_confirmation: boolean
  enabled: boolean
  /** 是否已开启自由交易（跳过确认） */
  free_trade: boolean
  /** 是否支持自由交易开关（需确认类写操作） */
  supports_free_trade: boolean
}

/** 工具箱列表响应 */
export interface AIToolListResponse {
  total: number
  disabled_count: number
  free_trade_count?: number
  items: AIToolItem[]
}

/** 获取 AI 可用工具列表（含开关状态） */
export async function getAITools(): Promise<AIToolListResponse> {
  return request<AIToolListResponse>("/api/ai/tools")
}

/** 启用/禁用指定工具 */
export async function setAIToolEnabled(
  toolName: string,
  enabled: boolean
): Promise<{ name: string; enabled: boolean; disabled_tools: string[] }> {
  return request(`/api/ai/tools/${encodeURIComponent(toolName)}/enabled`, {
    method: "PUT",
    body: JSON.stringify({ enabled }),
  })
}

/** 设置工具自由交易（跳过确认直接执行） */
export async function setAIToolFreeTrade(
  toolName: string,
  freeTrade: boolean
): Promise<{
  name: string
  free_trade: boolean
  free_trade_tools: string[]
}> {
  return request(
    `/api/ai/tools/${encodeURIComponent(toolName)}/free-trade`,
    {
      method: "PUT",
      body: JSON.stringify({ free_trade: freeTrade }),
    }
  )
}

// ===== AI Skills API =====

/** 搜索 skills 商城 */
export async function searchMarketplaceSkills(q: string, page: number, size: number, source: string = "skillsmp"): Promise<MarketplaceSkillItem[]> {
  return request<MarketplaceSkillItem[]>(`/api/ai/skills/marketplace/search?q=${encodeURIComponent(q)}&page=${page}&size=${size}&source=${source}`)
}

/** 获取商城排行榜 */
export async function getMarketplaceLeaderboard(page: number, size: number, source: string = "skillsmp"): Promise<MarketplaceSkillItem[]> {
  return request<MarketplaceSkillItem[]>(`/api/ai/skills/marketplace/leaderboard?page=${page}&size=${size}&source=${source}`)
}

/** 获取商城 skill 详情 */
export async function getMarketplaceSkillDetail(skillId: string, source: string = "skillsmp"): Promise<MarketplaceSkillDetail> {
  return request<MarketplaceSkillDetail>(`/api/ai/skills/marketplace/${skillId}?source=${source}`)
}

/** 获取已安装 skills 列表 */
export async function getInstalledSkills(): Promise<InstalledSkillItem[]> {
  return request<InstalledSkillItem[]>("/api/ai/skills/installed")
}

/** 从商城安装 skill */
export async function installSkillFromMarketplace(marketplaceId: string): Promise<InstalledSkillItem> {
  return request<InstalledSkillItem>("/api/ai/skills/install", {
    method: "POST",
    body: JSON.stringify({ marketplace_id: marketplaceId }),
  })
}

/** 从 Git URL 安装 skill */
export async function installSkillFromGit(gitUrl: string): Promise<InstalledSkillItem> {
  return request<InstalledSkillItem>("/api/ai/skills/install", {
    method: "POST",
    body: JSON.stringify({ git_url: gitUrl }),
  })
}

/** 上传自定义 skill */
export async function uploadSkill(file: File, name: string, triggerWord: string, description: string): Promise<InstalledSkillItem> {
  const formData = new FormData()
  formData.append("file", file)
  formData.append("name", name)
  formData.append("trigger_word", triggerWord)
  formData.append("description", description)

  const token = typeof window !== "undefined" ? localStorage.getItem("access_token") : null
  const headers: Record<string, string> = {}
  if (token) headers["Authorization"] = `Bearer ${token}`

  const response = await fetch(`${API_BASE}/api/ai/skills/upload`, {
    method: "POST",
    headers,
    body: formData,
  })
  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: "上传失败" }))
    throw new Error(error.detail ?? "上传失败")
  }
  return response.json()
}

/** 卸载 skill */
export async function uninstallSkill(skillId: string): Promise<void> {
  await request<void>(`/api/ai/skills/installed/${skillId}`, { method: "DELETE" })
}

/** 切换 skill 启用/禁用 */
export async function toggleSkill(skillId: string): Promise<InstalledSkillItem> {
  return request<InstalledSkillItem>(`/api/ai/skills/installed/${skillId}/toggle`, { method: "PUT" })
}

// ===== AI Skills Config API =====

/** 获取 Skills 配置 */
export async function getSkillConfig(): Promise<SkillConfig> {
  return request<SkillConfig>("/api/ai/skills/config")
}

/** 更新 Skills.sh token */
export async function updateSkillConfig(token: string): Promise<SkillConfig> {
  return request<SkillConfig>("/api/ai/skills/config", {
    method: "PUT",
    body: JSON.stringify({ token }),
  })
}

/** 删除 Skills.sh token */
export async function deleteSkillConfig(): Promise<void> {
  await request<void>("/api/ai/skills/config", { method: "DELETE" })
}

// ===== 通知 / 价格预警 =====

/** 后端 NotificationItem → 前端 Message（created_at → createdAt） */
function toMessage(raw: Record<string, unknown>): Message {
  return {
    id: String(raw.id),
    category: raw.category as MessageCategory,
    title: String(raw.title),
    content: String(raw.content),
    read: Boolean(raw.read),
    createdAt: String(raw.created_at ?? raw.createdAt ?? ""),
  }
}

/** 通知列表（可选类别/已读过滤） */
export async function getNotificationsApi(params: {
  category?: MessageCategory | ""
  read?: "unread" | "read" | ""
  limit?: number
  offset?: number
}): Promise<Message[]> {
  const qs = new URLSearchParams()
  if (params.category) qs.set("category", params.category)
  if (params.read) qs.set("read", params.read)
  if (params.limit) qs.set("limit", String(params.limit))
  if (params.offset) qs.set("offset", String(params.offset))
  const data = await request<Record<string, unknown>[]>(
    `/api/notifications?${qs.toString()}`,
  )
  return data.map(toMessage)
}

/** 未读条数 */
export async function getUnreadCountApi(): Promise<number> {
  const data = await request<{ unread: number }>("/api/notifications/unread-count")
  return data.unread
}

/** 标记单条已读 */
export async function markNotificationReadApi(id: string): Promise<void> {
  await request(`/api/notifications/${encodeURIComponent(id)}/read`, {
    method: "POST",
  })
}

/** 当前盘全部已读 */
export async function markAllNotificationsReadApi(): Promise<void> {
  await request("/api/notifications/read-all", { method: "POST" })
}

/** 删除单条通知 */
export async function deleteNotificationApi(id: string): Promise<void> {
  await request(`/api/notifications/${encodeURIComponent(id)}`, {
    method: "DELETE",
  })
}

/** 价格预警列表 */
export async function getPriceAlertsApi(): Promise<PriceAlert[]> {
  return request<PriceAlert[]>("/api/price-alerts")
}

/** 新建价格预警 */
export async function createPriceAlertApi(body: {
  symbol: string
  contract_name: string
  direction: "above" | "below"
  target_price: number
}): Promise<PriceAlert> {
  return request<PriceAlert>("/api/price-alerts", {
    method: "POST",
    body: JSON.stringify(body),
  })
}

/** 启停价格预警 */
export async function updatePriceAlertApi(
  id: string,
  enabled: boolean,
): Promise<PriceAlert> {
  return request<PriceAlert>(`/api/price-alerts/${encodeURIComponent(id)}`, {
    method: "PUT",
    body: JSON.stringify({ enabled }),
  })
}

/** 删除价格预警 */
export async function deletePriceAlertApi(id: string): Promise<void> {
  await request(`/api/price-alerts/${encodeURIComponent(id)}`, {
    method: "DELETE",
  })
}

/** 读取通知开关 */
export async function getNotifySettingsApi(): Promise<NotifySetting> {
  return request<NotifySetting>("/api/users/me/notify-settings")
}

/** 更新通知开关 */
export async function updateNotifySettingsApi(
  body: Partial<NotifySetting>,
): Promise<NotifySetting> {
  return request<NotifySetting>("/api/users/me/notify-settings", {
    method: "PUT",
    body: JSON.stringify(body),
  })
}

/** 读取当前用户图表指标配置（后端持久化，无记录返回默认） */
export async function getIndicatorSettingsApi(): Promise<IndicatorConfig> {
  return request<IndicatorConfig>("/api/indicators/settings")
}

/** 保存当前用户图表指标配置（整体替换，落库 PG） */
export async function saveIndicatorSettingsApi(
  config: IndicatorConfig,
): Promise<IndicatorConfig> {
  return request<IndicatorConfig>("/api/indicators/settings", {
    method: "PUT",
    body: JSON.stringify(config),
  })
}

// ===== 大单预警 =====

/** 大单预警设置（snake_case 对齐后端 schema） */
export interface BigOrderSettingsDTO {
  trading_mode?: string
  buy_enabled: boolean
  buy_threshold: number
  buy_color: string
  sell_enabled: boolean
  sell_threshold: number
  sell_color: string
  popup_enabled: boolean
  sound_enabled: boolean
  voice_enabled: boolean
}

/** 读取当前盘大单预警设置（不存在返回默认行） */
export async function getBigOrderSettingsApi(): Promise<BigOrderSettingsDTO> {
  return request<BigOrderSettingsDTO>("/api/users/me/big-orders/settings")
}

/** 更新大单预警设置（部分更新） */
export async function saveBigOrderSettingsApi(
  body: Partial<BigOrderSettingsDTO>,
): Promise<BigOrderSettingsDTO> {
  return request<BigOrderSettingsDTO>("/api/users/me/big-orders/settings", {
    method: "PUT",
    body: JSON.stringify(body),
  })
}

/** 逐秒成交（全市场公共数据，大单历史权威源） */
export interface TradeTickDTO {
  id: string
  symbol: string
  direction: "buy" | "sell" | ""
  volume: number
  price: number
  occurred_at: string
  trading_day: string
}

/**
 * 查询全市场逐秒成交（在某品种内按方向/手数过滤）。
 * 不传 trading_day 时后端默认查当前归属交易日。
 */
export async function getTradeTicksApi(params: {
  symbol?: string
  direction?: "buy" | "sell"
  min_volume?: number
  trading_day?: string
  limit?: number
}): Promise<TradeTickDTO[]> {
  const qs = new URLSearchParams()
  if (params.symbol) qs.set("symbol", params.symbol)
  if (params.direction) qs.set("direction", params.direction)
  if (params.min_volume) qs.set("min_volume", String(params.min_volume))
  if (params.trading_day) qs.set("trading_day", params.trading_day)
  if (params.limit) qs.set("limit", String(params.limit))
  const query = qs.toString()
  return request<TradeTickDTO[]>(
    `/api/users/me/big-orders/trade-ticks${query ? `?${query}` : ""}`,
  )
}

/** 成交量分布单价格档（四路开平为估算：持仓差分比例分摊） */
export interface VolumeProfileRowDTO {
  price: number
  open_long: number
  close_long: number
  open_short: number
  close_short: number
  /** 多单 = 开多 + 平空（主动买方力量） */
  buy_total: number
  /** 空单 = 开空 + 平多（主动卖方力量） */
  sell_total: number
  total: number
}

/** 成交量分布响应：当前交易日（前夜 21:00 夜盘起）按价格聚合 */
export interface VolumeProfileDTO {
  symbol: string
  trading_day: string
  /** 最新一笔成交时间（北京时间 ISO），无数据为 null */
  asof: string | null
  /** 最新一笔成交价（"最新价置顶"排序锚点），无数据为 null */
  last_price: number | null
  rows: VolumeProfileRowDTO[]
}

/** 成交量分布：当前交易日按价格聚合的多空力量（价格档全量返回，阈值筛选由前端做） */
export async function getVolumeProfileApi(
  symbol: string,
): Promise<VolumeProfileDTO> {
  const qs = new URLSearchParams({ symbol })
  return request<VolumeProfileDTO>(
    `/api/users/me/big-orders/volume-profile?${qs.toString()}`,
  )
}

