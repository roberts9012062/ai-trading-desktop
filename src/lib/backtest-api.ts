/** 历史回测 API */

const API_BASE = (process.env.NEXT_PUBLIC_API_URL ?? "").replace(/\/$/, "")

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token =
    typeof window !== "undefined" ? localStorage.getItem("access_token") : null
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...((options.headers as Record<string, string>) ?? {}),
  }
  if (token) headers.Authorization = `Bearer ${token}`
  let res: Response
  try {
    res = await fetch(`${API_BASE}${path}`, { ...options, headers })
  } catch {
    throw new Error("网络异常或代理超时，请缩短区间后重试")
  }
  if (!res.ok) {
    const raw = await res.text().catch(() => "")
    let msg = `请求失败: ${res.status}`
    if (raw) {
      try {
        const err = JSON.parse(raw) as {
          detail?: string | Array<{ msg?: string }>
        }
        if (typeof err?.detail === "string") msg = err.detail
        else if (Array.isArray(err?.detail) && err.detail[0]?.msg) {
          msg = String(err.detail[0].msg)
        }
      } catch {
        // Next 代理超时等场景可能返回纯文本 Internal Server Error
        if (res.status === 500 || res.status === 502 || res.status === 504) {
          msg =
            "回测请求中断（代理超时或服务异常）。请缩短区间后重试；AI 回测建议日线 + 1–2 个月"
        } else {
          msg = raw.slice(0, 200)
        }
      }
    }
    throw new Error(msg)
  }
  return res.json()
}

export interface BacktestRunPayload {
  name?: string
  strategy_type:
    | "ai"
    | "ma_cross"
    | "n_breakout"
    | "macd_cross"
    | "kdj_cross"
    | "band_swing"
    | "swing_pivot"
    | "swing_pivot_v2"
    | "swing_pro"
    | "strength_entry"
    | "strength_entry_v2"
    | "factor"
  strategy_params?: Record<string, unknown> | null
  /** AI 模式多选量化策略参考（注入 prompt 作为 AI 决策参考） */
  ref_strategies?: Array<{ kind: string; params?: Record<string, unknown> | null }> | null
  model_row_id?: string | null
  symbol: string
  symbol_name?: string
  timeframe: string
  start_date: string
  end_date: string
  data_channel?: string
  side_mode?: string
  fixed_qty?: number
  margin_per_trade?: number
  leverage?: number
  margin_mode?: "cross" | "isolated"
  initial_cash?: number
  /** aggressive/balanced/conservative */
  risk_style?: string
  custom_prompt_enabled?: boolean
  custom_prompt?: string | null
  close_rules?: Record<string, unknown>
  stop_rules?: Record<string, unknown>
  /** 多段回测：区间内随机抽取 segment_count 段（每段=周期上限天数）独立回测 */
  multi_segment?: boolean
  segment_count?: number
}

export interface BacktestMetrics {
  initial_cash: number
  final_equity: number
  total_return: number
  total_return_pct: number
  realized_pnl: number
  fees_paid: number
  max_drawdown: number
  max_drawdown_pct: number
  trade_count: number
  close_count: number
  win_count: number
  loss_count: number
  win_rate: number
  avg_win: number
  avg_loss: number
  profit_factor: number
}

export interface BacktestBar {
  time: string
  open: number
  high: number
  low: number
  close: number
  volume: number
}

export interface BacktestTrade {
  time?: string
  action?: string
  side?: string
  price?: number
  quantity?: number
  fee?: number
  pnl?: number
  reason?: string
  /** 本笔保证金（USDT） */
  margin?: number
  /** 杠杆倍数 */
  leverage?: number
  margin_mode?: "cross" | "isolated"
  /** 收益率（保证金口径 = 杠杆放大后） */
  pnl_pct_margin?: number
  /** 收益率（名义口径 = 价格变动百分比，r20 同款） */
  pnl_pct_notional?: number
}

/** 多段回测中单段的独立报告 */
export interface BacktestSegmentReport {
  index: number
  start_date: string
  end_date: string
  metrics: BacktestMetrics
  equity_curve: Array<{
    time: string
    equity: number
    cash: number
    unrealized: number
  }>
  bars?: BacktestBar[]
  trades: BacktestTrade[]
  decisions: Array<Record<string, unknown>>
  ai_calls?: number
  bar_count?: number
  trade_bars?: number
  message?: string
}

/** 多段汇总指标（附加在 metrics 上，与 BacktestMetrics 合并返回） */
export interface BacktestSegmentSummary {
  segment_count?: number
  winning_segments?: number
  segment_win_rate?: number
  mean_segment_return_pct?: number
  compound_return_pct?: number
  best_segment_return_pct?: number
  worst_segment_return_pct?: number
  mean_segment_drawdown_pct?: number
}

export interface BacktestReport {
  status: string
  config: Record<string, unknown>
  metrics: BacktestMetrics & BacktestSegmentSummary
  equity_curve: Array<{
    time: string
    equity: number
    cash: number
    unrealized: number
  }>
  /** 回测区间 K 线（用于标记买卖点）；多段模式为空，请看各段 bars */
  bars?: BacktestBar[]
  trades: BacktestTrade[]
  decisions: Array<Record<string, unknown>>
  message: string
  /** 多段回测时存在：各段独立报告 */
  segments?: BacktestSegmentReport[]
}

export interface BacktestLimits {
  max_days: number
  timeframes: string[]
  strategies: Array<{ value: string; label: string }>
  default_cash: number
  ai_max_calls: number
  notes: string[]
}

export function getBacktestLimitsApi(): Promise<BacktestLimits> {
  return request<BacktestLimits>("/api/backtest/limits")
}

export async function runBacktestApi(
  body: BacktestRunPayload,
  onProgress?: (msg: string) => void,
): Promise<BacktestReport> {
  const { prepareBacktestHistory } = await import("./backtest-history")
  const prepared = await prepareBacktestHistory(body, onProgress)
  const report = await request<BacktestReport>("/api/backtest/run", {
    method: "POST",
    body: JSON.stringify(prepared),
  })
  if (report.config?.history_source !== prepared.history_source) throw new Error("服务器尚未支持所选本机归档回测数据，请更新服务器后重试")
  return report
}

// ----------------------------------------------------------------
// AI 生成 K 线过拟合测试
// ----------------------------------------------------------------

/** LLM 产出的市场剧本（结构化参数） */
export interface SyntheticScript {
  regime: string
  trend_strength: number
  volatility: number
  drift_bps: number
  jumps: Array<{ at: number; direction: "up" | "down"; size: number }>
  volume_pattern: string
}

export interface SyntheticGenerateRequest {
  model_row_id: string
  symbol?: string
  symbol_name?: string
  timeframe: string
  num_days: number
  ref_price?: number | null
  seed?: number | null
}

export interface SyntheticGenerateResponse {
  session_id: string
  script: SyntheticScript
  bars: BacktestBar[]
  meta: {
    num_bars: number
    num_days: number
    ref_price: number
    amplitude: number
    symbol: string
    timeframe: string
  }
}

/** 账户快照（由后端 step 回传，前端持有并在下次请求时回传） */
export interface SyntheticAccountSnapshot {
  cash: number
  side: "long" | "short" | "flat"
  qty: number
  avg_price: number
  realized_pnl: number
  fees_paid: number
  equity: number
  trades: BacktestTrade[]
  last_price: number
  /** 专业波段信号K线止损锚（随快照无状态回传） */
  position_sl?: number | null
  /** 当前仓是否为止损反手仓（反手仓止损后不再反手） */
  was_reverse?: boolean
}

export interface SyntheticStepRequest {
  bars_so_far: BacktestBar[]
  account_snapshot: SyntheticAccountSnapshot | null
  strategy_type: BacktestRunPayload["strategy_type"]
  strategy_params?: Record<string, unknown> | null
  side_mode?: string
  fixed_qty?: number
  margin_per_trade?: number
  leverage?: number
  margin_mode?: "cross" | "isolated"
  initial_cash?: number
  risk_style?: string
  custom_prompt_enabled?: boolean
  custom_prompt?: string | null
  close_rules?: Record<string, unknown> | null
  stop_rules?: Record<string, unknown> | null
  max_hold_days?: number
  model_row_id?: string | null
  /** 决策模型 ID（Jev）：设置后量化策略信号作为参考输入，模型做最终判断 */
  decision_model_row_id?: string | null
  /** 决策模型最小调用间隔毫秒（=回放速度，后端钳制 2000-5000） */
  decision_min_interval_ms?: number
  /** 上次决策模型调用时刻（epoch ms，上一根 step 的 decision_called_at 回传） */
  last_decision_at?: number | null
  symbol?: string
  symbol_name?: string
  timeframe?: string
}

export interface SyntheticStepResponse {
  action: string
  quantity: number
  price: number
  reason: string
  source: string
  executed: boolean
  /** 决策模型调用时刻（epoch ms）；未调用/限频降级时回传上次锚点 */
  decision_called_at?: number | null
  decision: {
    time: string
    action: string
    quantity: number
    price: number
    reason: string
    source: string
  }
  account_snapshot: SyntheticAccountSnapshot
  equity_point: {
    time: string
    equity: number
    cash: number
    unrealized: number
  }
}

export function generateKlineApi(
  body: SyntheticGenerateRequest,
): Promise<SyntheticGenerateResponse> {
  return request<SyntheticGenerateResponse>("/api/backtest/generate-kline", {
    method: "POST",
    body: JSON.stringify(body),
  })
}

export function stepBacktestApi(
  body: SyntheticStepRequest,
): Promise<SyntheticStepResponse> {
  return request<SyntheticStepResponse>("/api/backtest/step", {
    method: "POST",
    body: JSON.stringify(body),
  })
}

export interface SyntheticFinishRequest {
  equity_curve: Array<{
    time: string
    equity: number
    cash: number
    unrealized: number
  }>
  trades: BacktestTrade[]
  account_snapshot: SyntheticAccountSnapshot | null
  initial_cash: number
  bars: BacktestBar[]
  strategy_type: string
  ai_calls: number
  timeframe?: string
  symbol?: string
  symbol_name?: string
}

export function finishBacktestApi(
  body: SyntheticFinishRequest,
): Promise<BacktestReport> {
  return request<BacktestReport>("/api/backtest/finish", {
    method: "POST",
    body: JSON.stringify(body),
  })
}
