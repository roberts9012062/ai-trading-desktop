/** AI 交易 API 客户端 */
export type Timeframe = "1m" | "5m" | "15m" | "30m" | "60m" | "1d"
export type SideMode = "long_only" | "short_only" | "both"
export type PositionMode = "full" | "half" | "fixed_qty" | "scale_in"
export type TaskStatus = "running" | "paused" | "stopped"
export type StrategyType = "ai" | "ma_cross" | "n_breakout"
/** 激进 / 稳健 / 保守 */
export type RiskStyle = "aggressive" | "balanced" | "conservative"
/** 技术指标平仓条件（多选）：持多仓遇死叉/波段波峰反转平多、持空仓遇金叉/波段波谷反转平空 */
export interface IndicatorExitItem {
  kind: "macd_cross" | "ma_cross" | "kdj_cross" | "swing_pivot" | string
  params?: Record<string, unknown>
}
/** 因子阈值平仓：decay=动能衰减（跌破正阈值平多/回升破负阈值平空）；
 * reach=达到即平（过热离场，且此时不开新仓） */
export interface FactorExitConfig {
  mode: "decay" | "reach" | string
  long_threshold: number
  short_threshold: number
}
export interface CloseRules {
  pnl_pct: number | null
  total_pnl_pct: number | null
  session_close: boolean
  ai_auto: boolean
  /** 平仓由决策模型自己决定（仅 decision 策略；标记用，引擎实际走 ai_auto） */
  model_exit?: boolean
  indicator_exits?: IndicatorExitItem[] | null
  factor_exit?: FactorExitConfig | null
}
export interface StopRules {
  loss_pct: number | null
  loss_amount: number | null
  ai_auto: boolean
}
export interface MaCrossParams {
  fast_period: number
  slow_period: number
  ma_type: "sma" | "ema" | string
}
export interface NBreakoutParams {
  lookback: number
}
export interface AITradingTask {
  id: string
  user_id: string
  name: string
  model_row_id: string | null
  model_id: string | null
  model_display_name: string | null
  provider_name: string | null
  strategy_type?: StrategyType | string
  strategy_params?: MaCrossParams | NBreakoutParams | Record<string, unknown>
  icon?: string | null
  symbol: string
  symbol_name: string
  timeframe: Timeframe | string
  /** 多周期共振附加周期（不含主周期，最多3个，仅 AI 策略生效） */
  extra_timeframes?: string[]
  /** AI 每周期查看 K 线根数（默认40，10-240） */
  ai_bars_limit?: number
  /** 决策模型评估间隔秒（60-300，仅 decision 策略） */
  decision_interval_sec?: number
  /** 量化任务分析间隔秒（0=按K线收盘，60~K线周期秒数，全部量化策略） */
  quant_interval_sec?: number
  /** 波段任务信号K线止损锚价（开仓时定，平仓清空；空=未启用） */
  signal_stop_price?: number | null
  /** 波段任务止损反手仓锚价（与signal_stop_price互换；空=百分比模式或未启用） */
  signal_stop_reverse_price?: number | null
  side_mode: SideMode | string
  position_mode: PositionMode | string
  fixed_qty: number
  /** 开仓最少/最多手数 */
  qty_min?: number
  qty_max?: number
  /** AI 资金仓额度（元） */
  allocated_capital?: number
  /** 资金仓使用比例 0-100 */
  capital_usage_min_pct?: number
  capital_usage_max_pct?: number
  /** aggressive/balanced/conservative */
  risk_style?: RiskStyle | string
  /** 最长持仓天数 */
  max_hold_days?: number
  custom_prompt_enabled?: boolean
  custom_prompt?: string | null
  position_opened_at?: string | null
  close_rules: CloseRules
  stop_rules: StopRules
  status: TaskStatus | string
  /** user=手动暂停；market_closed=休市自动暂停 */
  pause_reason?: string | null
  equity_baseline: number
  close_on_stop: boolean
  last_run_at: string | null
  next_bar_ts: string | null
  last_bar_time: string | null
  started_at: string | null
  paused_at: string | null
  stopped_at: string | null
  /** 累计实际运行秒数（扣除暂停段） */
  runtime_seconds?: number
  /** 本次运行段起点（仅 running 时有值） */
  run_started_at?: string | null
  note: string | null
  created_at: string
  updated_at: string
  cash_delta: number | null
  /** 是否可修改（已结束且无持仓/未下单） */
  can_edit?: boolean | null
  /** 是否可调整盈亏比例（该品种无持仓即可，运行中也允许） */
  can_edit_rules?: boolean | null
  has_orders?: boolean | null
  has_open_position?: boolean | null
  /** 任务品种持仓：long/short，无仓为 null */
  position_direction?: string | null
  /** 持仓手数 */
  position_qty?: number | null
  /** 开仓均价 */
  position_avg_price?: number | null
  /** 最新价（服务端 Redis 行情） */
  position_last_price?: number | null
  /** 浮动盈亏（元，不含手续费） */
  position_unrealized?: number | null
  /** 胜率统计：盈利平仓笔数 */
  win_count?: number
  /** 胜率统计：亏损平仓笔数 */
  loss_count?: number
  /** 胜率统计：累计平仓笔数 */
  trade_count?: number
  /** 胜率百分比（0-100） */
  win_rate?: number
}
export interface AITradingDecision {
  id: string
  task_id: string
  bar_time: string | null
  timeframe: string
  trigger_type: string
  context_summary: Record<string, unknown> | null
  model_output: Record<string, unknown> | null
  action: string
  order_id: string | null
  reason: string
  created_at: string
}
export interface EquityPoint {
  task_id: string
  ts: string
  equity: number
  cash_delta: number
  realized_pnl: number
  unrealized_pnl: number
}

/** 总收益柱：一任务一柱（realized+unrealized=total_pnl） */
export interface ProfitCloseBar {
  id: string
  task_id: string
  task_name: string
  symbol: string
  symbol_name: string
  direction: string
  offset: string
  price: number
  filled_qty: number
  fee: number
  /** 浮盈（兼容旧字段） */
  pnl: number
  /** 任务总收益 */
  cumulative: number
  filled_at: string
  decision_action: string
  /** 已实现盈亏 */
  realized?: number
  /** 持仓浮盈 */
  unrealized?: number
  /** 总收益 */
  total_pnl?: number
  status?: string
  has_open_position?: boolean
  kind?: string
  /** 任务头像 slug（自动匹配时为 null） */
  icon?: string | null
  strategy_type?: string
  model_id?: string | null
  model_display_name?: string | null
  provider_name?: string | null
}
export interface CreateTaskPayload {
  name: string
  model_row_id?: string | null
  strategy_type?: StrategyType | string
  strategy_params?: MaCrossParams | NBreakoutParams | Record<string, unknown>
  icon?: string | null
  symbol: string
  symbol_name: string
  timeframe: string
  /** 多周期共振附加周期（最多3个，仅 AI 策略生效） */
  extra_timeframes?: string[]
  /** AI 每周期查看 K 线根数（10-240，默认40） */
  ai_bars_limit?: number
  /** 决策模型评估间隔秒（60-300，仅 decision 策略） */
  decision_interval_sec?: number
  /** 量化任务分析间隔秒（0=按K线收盘，60~K线周期秒数，全部量化策略） */
  quant_interval_sec?: number
  side_mode: string
  position_mode: string
  fixed_qty: number
  qty_min?: number
  qty_max?: number
  allocated_capital?: number
  capital_usage_min_pct?: number
  capital_usage_max_pct?: number
  risk_style?: RiskStyle | string
  /** 交易周期（最长持仓天数）；空=按 K 线周期取默认 */
  max_hold_days?: number | null
  custom_prompt_enabled?: boolean
  custom_prompt?: string | null
  close_rules: CloseRules
  stop_rules: StopRules
  close_on_stop: boolean
  auto_start: boolean
}

/** 修改任务（字段均可选） */
export interface UpdateTaskPayload {
  name?: string
  model_row_id?: string | null
  strategy_params?: MaCrossParams | NBreakoutParams | Record<string, unknown>
  icon?: string | null
  symbol?: string
  symbol_name?: string
  timeframe?: string
  extra_timeframes?: string[]
  ai_bars_limit?: number
  /** 决策模型评估间隔秒（60-300，仅 decision 策略） */
  decision_interval_sec?: number
  /** 量化任务分析间隔秒（0=恢复按K线收盘，全部量化策略） */
  quant_interval_sec?: number
  side_mode?: string
  position_mode?: string
  fixed_qty?: number
  qty_min?: number
  qty_max?: number
  allocated_capital?: number
  capital_usage_min_pct?: number
  capital_usage_max_pct?: number
  risk_style?: RiskStyle | string
  /** 交易周期（最长持仓天数）；空=不变 */
  max_hold_days?: number | null
  custom_prompt_enabled?: boolean
  custom_prompt?: string | null
  close_rules?: CloseRules
  stop_rules?: StopRules
  close_on_stop?: boolean
}

const API_BASE = (process.env.NEXT_PUBLIC_API_URL ?? "").replace(/\/$/, "")

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token =
    typeof window !== "undefined" ? localStorage.getItem("access_token") : null
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...((options.headers as Record<string, string>) ?? {}),
  }
  if (token) headers["Authorization"] = `Bearer ${token}`

  const response = await fetch(`${API_BASE}${path}`, { ...options, headers })
  if (response.status === 401 && typeof window !== "undefined") {
    window.location.href = "/login"
    throw new Error("认证过期")
  }
  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: "请求失败" }))
    let detailText = `请求失败: ${response.status}`
    if (typeof error?.detail === "string") detailText = error.detail
    throw new Error(detailText)
  }
  return response.json() as Promise<T>
}
export async function listAITradingTasks(): Promise<{
  total: number
  items: AITradingTask[]
}> {
  return request("/api/ai-trading/tasks")
}
export async function createAITradingTask(
  payload: CreateTaskPayload,
): Promise<AITradingTask> {
  return request("/api/ai-trading/tasks", {
    method: "POST",
    body: JSON.stringify(payload),
  })
}

export interface EstimateCapitalResult {
  symbol: string
  last_price: number
  multiplier: number
  margin_rate: number
  fee_mode: string
  per_hand_margin: number | null
  total_needed: number | null
}

/** 估算给定手数开仓所需 AI 资金仓额度 */
export async function estimatePositionCapital(
  symbol: string,
  qty: number,
): Promise<EstimateCapitalResult> {
  return request<EstimateCapitalResult>("/api/ai-trading/estimate-capital", {
    method: "POST",
    body: JSON.stringify({ symbol, qty }),
  })
}
export async function updateAITradingTask(
  id: string,
  payload: UpdateTaskPayload,
): Promise<AITradingTask> {
  return request(`/api/ai-trading/tasks/${id}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  })
}

export interface UpdateTaskRulesPayload {
  close_rules?: CloseRules
  stop_rules?: StopRules
}

/** 无持仓时调整止盈/止损规则（运行/暂停/已结束均可，运行中下轮评估生效） */
export async function updateAITradingTaskRules(
  id: string,
  payload: UpdateTaskRulesPayload,
): Promise<AITradingTask> {
  return request(`/api/ai-trading/tasks/${id}/rules`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  })
}
export async function getAITradingTask(id: string): Promise<AITradingTask> {
  return request(`/api/ai-trading/tasks/${id}`)
}
export async function startAITradingTask(id: string): Promise<AITradingTask> {
  return request(`/api/ai-trading/tasks/${id}/start`, { method: "POST" })
}
export async function pauseAITradingTask(id: string): Promise<AITradingTask> {
  return request(`/api/ai-trading/tasks/${id}/pause`, { method: "POST" })
}
export async function stopAITradingTask(
  id: string,
  forceClose: boolean,
): Promise<AITradingTask> {
  return request(
    `/api/ai-trading/tasks/${id}/stop?force_close=${forceClose ? "true" : "false"}`,
    { method: "POST" },
  )
}
/** 删除已结束且无持仓的任务（级联决策/权益点） */
export async function deleteAITradingTask(
  id: string,
): Promise<{ deleted: boolean; symbol?: string }> {
  return request(`/api/ai-trading/tasks/${id}`, { method: "DELETE" })
}
export async function listAITradingDecisions(
  id: string,
  limit: number,
  offset: number,
): Promise<{ total: number; items: AITradingDecision[] }> {
  return request(
    `/api/ai-trading/tasks/${id}/decisions?limit=${limit}&offset=${offset}`,
  )
}
export async function listTaskRunLogs(
  id: string,
  limit: number,
  level?: string,
  event?: string,
): Promise<{ total: number; items: unknown[] }> {
  const q = new URLSearchParams({ limit: String(limit) })
  if (level) q.set("level", level)
  if (event) q.set("event", event)
  return request(`/api/ai-trading/tasks/${id}/run-logs?${q.toString()}`)
}

export async function listAITradingTrades(
  id: string,
  limit: number,
  offset: number,
): Promise<{ total: number; items: Record<string, unknown>[] }> {
  return request(
    `/api/ai-trading/tasks/${id}/trades?limit=${limit}&offset=${offset}`,
  )
}

/** 任务 K 线交易标记（已成交委托最小字段集，按时间升序） */
export interface TaskTradeMark {
  order_id: string
  task_id: string
  symbol: string
  direction: "buy" | "sell" | string
  offset: "open" | "close" | string
  price: number
  filled_qty: number
  time: string
}

export async function listTaskTradeMarks(
  id: string,
  limit = 1000,
): Promise<{ total: number; items: TaskTradeMark[] }> {
  return request(
    `/api/ai-trading/tasks/${id}/trade-marks?limit=${limit}`,
  )
}

/** 任务预警设置（AI 看盘行情页） */
export interface TaskAlertSettings {
  open_enabled: boolean
  close_enabled: boolean
  popup_enabled: boolean
  sound_enabled: boolean
  voice_enabled: boolean
}

export async function getTaskAlertSettingsApi(): Promise<TaskAlertSettings> {
  return request("/api/users/me/task-alerts/settings")
}

export async function saveTaskAlertSettingsApi(
  s: TaskAlertSettings,
): Promise<TaskAlertSettings> {
  return request("/api/users/me/task-alerts/settings", {
    method: "PUT",
    body: JSON.stringify(s),
  })
}
export async function fetchEquitySeries(
  taskIds: string[],
  limit: number,
): Promise<{ series: Record<string, EquityPoint[]> }> {
  const q = taskIds.length
    ? `?task_ids=${taskIds.join(",")}&limit=${limit}`
    : `?limit=${limit}`
  return request(`/api/ai-trading/equity${q}`)
}

/** 总收益柱：平仓累计 + 持仓浮盈 */
export async function fetchProfitBars(limit: number): Promise<{
  total: number
  total_realized: number
  total_unrealized: number
  total_pnl: number
  open_position_count: number
  items: ProfitCloseBar[]
}> {
  return request(`/api/ai-trading/profit-bars?limit=${limit}`)
}
export async function runAITradingOnce(
  id: string,
): Promise<Record<string, unknown>> {
  return request(`/api/ai-trading/tasks/${id}/run-once`, { method: "POST" })
}

/** 切换任务模型并立即用新模型执行一次（接手操盘） */
export async function switchTaskModel(
  taskId: string,
  modelRowId: string,
): Promise<{ task: AITradingTask; decision: Record<string, unknown> }> {
  return request(`/api/ai-trading/tasks/${taskId}/switch-model`, {
    method: "POST",
    body: JSON.stringify({ model_row_id: modelRowId }),
  })
}

export async function switchTaskSite(
  taskId: string,
  executionSite: "server" | "client",
): Promise<{ ok: boolean; execution_site: string }> {
  return request(`/api/ai-trading/tasks/${taskId}/switch-site`, {
    method: "POST",
    body: JSON.stringify({ execution_site: executionSite }),
  })
}

export interface ClientDecisionPayload {
  action: string
  quantity: number
  reason?: string
  confidence?: number
  raw?: string | null
  bar_time?: string | null
  trigger_type?: string
}

export async function submitClientDecision(
  taskId: string,
  payload: ClientDecisionPayload,
): Promise<Record<string, unknown>> {
  return request(`/api/ai-trading/tasks/${taskId}/client-decision`, {
    method: "POST",
    body: JSON.stringify(payload),
  })
}

