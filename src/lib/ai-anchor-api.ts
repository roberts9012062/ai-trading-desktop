/**
 * AI 看盘主播 API 客户端 —— 配置启动/暂停/恢复/停止与播报查询
 *
 * 基址与 api.ts 同约定：空字符串 = 同域（Next rewrites /api → 后端）。
 */

const API_BASE = (process.env.NEXT_PUBLIC_API_URL ?? "").replace(/\/$/, "")

/** 技术线条目（名称 + 参数，可重复添加如 MA20 + MA60） */
export interface AnchorIndicatorItem {
  name: string
  params: Record<string, number>
}

/** 方向偏好：any=双向 / long=只做多 / short=只做空 */
export type AnchorDirectionMode = "any" | "long" | "short"

/** 操盘策略：aggressive=激进 / balanced=稳健 / conservative=保守 */
export type AnchorStrategy = "aggressive" | "balanced" | "conservative"

/** 交易风格（持仓周期维度，与操盘策略正交）：short=短线 / mid=中线 / long=长线 */
export type AnchorHorizon = "short" | "mid" | "long"

/** 合法分时K线段（不含 tick 与日线） */
export const ANCHOR_TIMEFRAMES = ["1m", "5m", "15m", "30m", "60m", "240m"] as const

/** 分时段多选上限 */
export const MAX_TIMEFRAMES = 3

/** AI 标注的关键压力位/支撑位 */
export interface AnchorKeyLevel {
  price: number
  type: "resistance" | "support"
  label: string
}

/** 用户手动录入的持仓（持仓互动播报） */
export interface AnchorManualPosition {
  symbol: string
  direction: "long" | "short"
  price: number
  quantity: number
}

/** 持仓操作建议（模型输出，仅持仓播报时存在） */
export interface AnchorPositionAdvice {
  action: "hold" | "add" | "reduce" | "close"
  note: string
}

/** 主播任务（配置 + 状态） */
export interface AnchorTask {
  id: string
  model_row_id: string
  symbol: string
  timeframe: string
  timeframes: string[]
  direction_mode: AnchorDirectionMode
  strategy: AnchorStrategy
  horizon: AnchorHorizon
  bar_count: number
  interval_minutes: number
  indicators: AnchorIndicatorItem[]
  status: "running" | "paused" | "stopped"
  next_run_at: string | null
  last_run_at: string | null
  market_open: boolean
  manual_position: AnchorManualPosition | null
}

/** 单条播报 */
export interface AnchorBroadcast {
  id: string
  symbol: string
  timeframe: string
  direction: "long" | "short" | "neutral"
  entry: number | null
  take_profit: number | null
  stop_loss: number | null
  action: "trade" | "wait"
  commentary: string
  model_error: boolean
  key_levels: AnchorKeyLevel[] | null
  position_advice: AnchorPositionAdvice | null
  bar_time: string | null
  created_at: string
}

/** 状态总览 */
export interface AnchorStatus {
  task: AnchorTask | null
  recent_broadcasts: AnchorBroadcast[]
}

/** 启动配置请求体（timeframes 第一个为主时段；timeframe 字段仅旧版兼容） */
export interface AnchorStartConfig {
  model_row_id: string
  symbol: string
  timeframes: string[]
  direction_mode: AnchorDirectionMode
  strategy?: AnchorStrategy
  horizon?: AnchorHorizon
  bar_count: number
  interval_minutes: number
  indicators: AnchorIndicatorItem[]
}

/** 可选技术线及参数 schema（后端下发，渲染参数表单用） */
export interface AnchorParamSpec {
  key: string
  label: string
  default: number
  min: number
  max: number
  step: number
}

/** 云端自然音色（微软 Edge 神经网络音色,后端代理合成） */
export interface AnchorCloudVoice {
  id: string
  name: string
  desc: string
}

/** 通用请求封装（带 token，401 抛错由调用方提示） */
async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token =
    typeof window !== "undefined" ? localStorage.getItem("access_token") : null
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...((options.headers as Record<string, string>) ?? {}),
  }
  if (token) headers.Authorization = `Bearer ${token}`
  const response = await fetch(`${API_BASE}${path}`, { ...options, headers })
  if (!response.ok) {
    let detail = `HTTP ${response.status}`
    try {
      const body = (await response.json()) as { detail?: string }
      if (body?.detail) detail = String(body.detail)
    } catch {
      // 非 JSON 错误体
    }
    throw new Error(detail)
  }
  return (await response.json()) as T
}

/** 主播状态总览 */
export async function getAnchorStatusApi(): Promise<AnchorStatus> {
  return request<AnchorStatus>("/api/ai-anchor/status")
}

/** 保存配置并启动（每用户每盘模式单任务，覆盖配置） */
export async function startAnchorApi(config: AnchorStartConfig): Promise<AnchorStatus> {
  return request<AnchorStatus>("/api/ai-anchor/start", {
    method: "POST",
    body: JSON.stringify(config),
  })
}

/** 暂停（保留配置与历史） */
export async function pauseAnchorApi(): Promise<AnchorStatus> {
  return request<AnchorStatus>("/api/ai-anchor/pause", { method: "POST" })
}

/** 恢复（立即触发一轮播报） */
export async function resumeAnchorApi(): Promise<AnchorStatus> {
  return request<AnchorStatus>("/api/ai-anchor/resume", { method: "POST" })
}

/** 停止（配置保留为草稿，历史保留） */
export async function stopAnchorApi(): Promise<AnchorStatus> {
  return request<AnchorStatus>("/api/ai-anchor/stop", { method: "POST" })
}

/** 运行中热更新配置（切换模型/操盘策略/交易风格，不打断播放节奏） */
export async function patchAnchorConfigApi(patch: {
  model_row_id?: string
  strategy?: AnchorStrategy
  horizon?: AnchorHorizon
}): Promise<AnchorStatus> {
  return request<AnchorStatus>("/api/ai-anchor/config", {
    method: "PATCH",
    body: JSON.stringify(patch),
  })
}

/** 播报历史（倒序） */
export async function getAnchorBroadcastsApi(limit: number): Promise<AnchorBroadcast[]> {
  const data = await request<{ total: number; items: AnchorBroadcast[] }>(
    `/api/ai-anchor/broadcasts?limit=${limit}`,
  )
  return data.items
}

/** 录入/更新手动持仓（下一轮播报起汇报持仓状态并给持仓建议） */
export async function setAnchorPositionApi(
  position: AnchorManualPosition,
): Promise<AnchorStatus> {
  return request<AnchorStatus>("/api/ai-anchor/position", {
    method: "PUT",
    body: JSON.stringify(position),
  })
}

/** 清除手动持仓（恢复普通播报） */
export async function clearAnchorPositionApi(): Promise<AnchorStatus> {
  return request<AnchorStatus>("/api/ai-anchor/position", { method: "DELETE" })
}

/** 可选技术线及参数 schema */
export async function getAnchorIndicatorsApi(): Promise<Record<string, AnchorParamSpec[]>> {
  const data = await request<{ indicators: Record<string, AnchorParamSpec[]> }>(
    "/api/ai-anchor/indicators",
  )
  return data.indicators
}

/** 云端自然音色列表 */
export async function getAnchorVoicesApi(): Promise<AnchorCloudVoice[]> {
  const data = await request<{ voices: AnchorCloudVoice[] }>("/api/ai-anchor/voices")
  return data.voices
}

/**
 * 云端 TTS 合成:返回 mp3 Blob;失败抛错(调用方回退本地语音)
 * 独立实现(不走通用 request):需要 blob 响应而非 JSON
 */
export async function synthesizeAnchorTtsApi(
  text: string,
  voice: string,
  rate: number,
): Promise<Blob> {
  const token =
    typeof window !== "undefined" ? localStorage.getItem("access_token") : null
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (token) headers.Authorization = `Bearer ${token}`
  const response = await fetch(`${API_BASE}/api/ai-anchor/tts`, {
    method: "POST",
    headers,
    body: JSON.stringify({ text, voice, rate }),
  })
  if (!response.ok) {
    throw new Error(`TTS HTTP ${response.status}`)
  }
  return response.blob()
}
