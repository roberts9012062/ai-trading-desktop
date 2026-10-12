import type {FactorValidationSettings} from "./factor-validation-settings"
import type {KlineBar} from "@/types"
import {barTimeToMs} from "./binance-kline"

export const EVOLUTION_CADENCE: Record<string, number> = {"1m":60, "3m":180, "5m":300, "15m":900, "30m":1800, "60m":3600, "240m":14400, "1d":86400}
type Validation = Pick<FactorValidationSettings, "train_ratio" | "test_recent_bars" | "walk_forward_folds">
export function evolutionSamplePlan(n: number, timeframe: string, settings: Validation) {
  const cadence = EVOLUTION_CADENCE[timeframe]
  if (!cadence) throw new Error("当前周期不支持因子进化")
  const days = ["1m", "3m", "5m", "15m", "30m"].includes(timeframe) ? 7 : 30
  const spanBars = Math.ceil(days * 86400 / cadence) + 1
  const minValidation = Math.max(120, settings.walk_forward_folds * 60, spanBars)
  const minHoldout = Math.max(120, spanBars)
  const warmup = Math.max(300, Math.max(200, Math.ceil(86400 / cadence)) + 120)
  const visible = Math.floor(n * .8)
  const train = settings.test_recent_bars ? visible - settings.test_recent_bars : Math.floor(visible * settings.train_ratio)
  const validation = visible - train, holdout = n - visible
  const minTrain = timeframe === "1d" ? 200 : 500
  const fixedIssue = settings.test_recent_bars > 0 && settings.test_recent_bars < minValidation
    ? `固定测试窗口过短：近期作测试为 ${settings.test_recent_bars} 根，${timeframe} 至少需要 ${minValidation} 根（${settings.walk_forward_folds} 折、每折至少 60 根，且跨度至少 ${days} 天）。请改为 0（按比例）或增加测试根数；扩大历史区间无法解决。` : null
  const issue = fixedIssue || (n < 1000 || train - warmup < minTrain || validation < minValidation || holdout < minHoldout
    ? `样本不足：实际 ${n} 根，训练预热后 ${Math.max(0, train - warmup)} 根（预热 ${warmup}，需 ${minTrain}），验证 ${validation} 根（需 ${minValidation}），封存 ${holdout} 根（需 ${minHoldout}）；请扩大历史区间。` : null)
  return {train, validation, holdout, warmup, minTrain, minValidation, minHoldout, days, fixedIssue, issue}
}

export function evolutionBarTime(bar: KlineBar): number {
  if (bar.open_time != null) return bar.open_time
  return /^\d{4}-\d{2}-\d{2}$/.test(bar.time) ? Date.parse(`${bar.time}T00:00:00Z`)
    : /T|Z|[+-]\d{2}:\d{2}$/.test(bar.time) ? Date.parse(bar.time) : barTimeToMs(bar.time)
}

export function evolutionHistoryGap(bars: KlineBar[], timeframe: string) {
  const step = EVOLUTION_CADENCE[timeframe] * 1000
  for (let i = 1; i < bars.length; i++) {
    if (Math.abs(evolutionBarTime(bars[i]) - evolutionBarTime(bars[i-1]) - step) > 1000) {
      const after = bars[i-1].time, next = bars[i].time
      // A date input cannot exclude an intraday gap; start the following day.
      const suggestedStart = new Date(Date.parse(`${next.slice(0,10)}T00:00:00Z`) + 86400000).toISOString().slice(0,10)
      return {after, next, suggestedStart, message: `历史 K 线有缺口：${after} → ${next}，不满足连续 ${timeframe} 周期。可从 ${suggestedStart} 开始使用后续历史，或切换 Binance 渠道；未合成缺失 K 线。`}
    }
  }
  return null
}

/** Funding files are monthly. This is a conservative suggestion, not a claim
 * that the previous month's file has already been published. */
export function completeFundingMonthEnd(now = Date.now()): string {
  const date = new Date(now)
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 0)).toISOString().slice(0,10)
}

export function evolutionFundingIssue(bars: KlineBar[], events: Array<{t: number; r: number}>) {
  const sorted = [...new Set(events.map(e => e.t))].sort((a,b) => a-b)
  const tolerance = 12 * 3600000
  const gap = sorted.findIndex((t,i) => i > 0 && t - sorted[i-1] > tolerance)
  if (!sorted.length || sorted[0] > evolutionBarTime(bars[0]) + tolerance || sorted.at(-1)! < evolutionBarTime(bars.at(-1)!) - tolerance || gap >= 0) {
    const available = sorted.length ? `${new Date(sorted[0]).toISOString()} 至 ${new Date(sorted.at(-1)!).toISOString()}` : "无已发布事件"
    return `永续资金费率结算覆盖不完整：实际 ${available}${gap >= 0 ? `，${new Date(sorted[gap-1]).toISOString()} 后有结算缺口` : ""}。资金费率使用月归档，当月通常尚未发布；请调整日期至已发布且连续的历史，未用零费率补齐。`
  }
  return null
}
