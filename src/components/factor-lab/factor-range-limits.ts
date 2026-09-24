/** 因子评估专用区间上限 —— 与后端 FACTOR_TF_MAX_DAYS 镜像
 *
 * 不复用策略回测的 timeframe-limits（15m=30 天为策略运行时设计）：
 * 因子评估是向量化计算，负担得起更长历史；短区间会让 walk-forward
 * 每折样本不足，严格筛全军覆没（全部 ⚠）。 */

export const FACTOR_TF_MAX_DAYS: Record<string, number> = {
  "1d": 1825,
  "60m": 365,
  "30m": 240,
  "15m": 180,
  "5m": 90,
  "1m": 30,
}

const DEFAULT_MAX_DAYS = 30

/** 周期 → 因子评估最大自然天数 */
export function factorMaxDaysFor(timeframe: string): number {
  return FACTOR_TF_MAX_DAYS[timeframe] ?? DEFAULT_MAX_DAYS
}

/** 给定周期的推荐初始区间（最近可用） */
export function defaultFactorRangeFor(
  timeframe: string,
  today: Date,
): { start: string; end: string } {
  const max = factorMaxDaysFor(timeframe)
  const end = new Date(today)
  const start = new Date(today)
  start.setUTCDate(start.getUTCDate() - max)
  const toISO = (d: Date) => d.toISOString().slice(0, 10)
  return { start: toISO(start), end: toISO(end) }
}
