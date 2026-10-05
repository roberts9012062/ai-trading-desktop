import type { CadenceSeconds, ShortlineTimeframe } from "./spec"
import type { ShortlineHistorySource } from "@/lib/okx-history"

export interface ExecutionSettings {
  margin: number
  leverage: number
  margin_mode: "isolated" | "cross"
  stop_loss_pct: number
  take_profit_pct: number
  profit_lock: { enabled: boolean, mode: "auto", cooldown_signals: number }
}
export const DEFAULT_EXECUTION_SETTINGS: ExecutionSettings = {
  margin: 100, leverage: 5, margin_mode: "isolated", stop_loss_pct: 5, take_profit_pct: 20,
  profit_lock: { enabled: true, mode: "auto", cooldown_signals: 1 },
}
export interface ExecutionObservation { t: number, price: number, score: number | null, funding_rate?: number }
export interface ExecutionMetrics {
  closed_trades: number, wins: number, losses: number, win_rate: number,
  net_profit: number, expectancy: number, payoff_ratio: number | null,
  profit_factor: number | null, max_drawdown: number, fees: number, funding: number,
  average_win: number, average_loss: number, gaps: number, missing_scores: number,
}
export interface ExecutionReview {
  version: string, source: string, qualified: boolean, research_passed: boolean,
  reasons: string[], limitations: string[], review_sha: string,
  configuration: Record<string, unknown>,
  base: { metrics: ExecutionMetrics, trades: Record<string, unknown>[], equity: [number, number][] },
  stress: { metrics: ExecutionMetrics, trades: Record<string, unknown>[], equity: [number, number][] },
  periods: ExecutionMetrics[],
}
export interface ReviewWorkerRequest {
  symbol: string, timeframe: ShortlineTimeframe, cadence: CadenceSeconds,
  champions: { tokens: number[] }[], days: number,
  source?: ShortlineHistorySource,
}
export const REVIEW_REASONS: Record<string, string> = {
  insufficient_closed_trades: "闭合交易不足：全段至少100轮，后半段至少50轮",
  negative_net_expectancy: "全段或复核分段净期望不为正",
  profit_factor_below_1_3: "净利润因子低于1.3或亏损样本不足",
  payoff_below_2: "实际平均净盈亏比低于2:1或亏损样本不足（优化目标3:1）",
  stress_failed: "双倍手续费/滑点、额外一步延迟压力未通过",
  incomplete_data: "行情存在缺口或无效分数",
  venue_mismatch: "逐笔历史来自Binance，还需要OKX独立验证",
}

export function boundedReviewDays(days: number, cadence: CadenceSeconds): number {
  if (!Number.isFinite(days) || days < 1) throw new Error("回放天数须为正数")
  return Math.min(Math.floor(days), Math.floor(149000 * cadence / 86400), 60)
}
