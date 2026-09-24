/** 回测周期 → 最大自然天数 + 时间尺跨度（纯常量与函数） */

/** 时间尺统一固定起点：所有周期都可向左拖到这一天。
 * 日线有 PG 历史库支撑；分钟线受新浪数据源限制只能回溯近期，
 * 但时间尺本身统一留足探索空间，用户在尺上拖选区即可。 */
export const RAIL_START_ISO = "2005-01-01"

/** 各周期允许的最大回测自然天数（与后端 TIMEFRAME_MAX_DAYS 一致） */
export const TIMEFRAME_MAX_DAYS: Record<string, number> = {
  "1d": 1825,
  "60m": 90,
  "30m": 60,
  "15m": 30,
  "5m": 7,
  "1m": 3,
}

export const DEFAULT_MAX_DAYS = 30

/** 多段回测：段数范围（与后端 SEGMENT_MIN/MAX_COUNT 一致）。
 * 日线（1d）不支持多段。 */
export const SEGMENT_MIN_COUNT = 2
export const SEGMENT_MAX_COUNT = 5
export const SEGMENT_TIMEFRAMES = ["60m", "30m", "15m", "5m", "1m"] as const

/** 多段回测最小区间（含首尾天）= 段数 × 该周期上限天数。
 * 每段长度固定为周期上限（如 15m 每段 30 天），提交后由后端
 * 在所选区间内随机抽取互不重叠的 N 段。 */
export function multiSegmentMinDays(timeframe: string, segments: number): number {
  return maxDaysFor(timeframe) * segments
}

/** 含首尾的自然天数（2026-05-01 ~ 2026-05-30 = 30 天），与后端口径一致 */
export function inclusiveDays(startISO: string, endISO: string): number {
  const s = new Date(startISO)
  const e = new Date(endISO)
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) return 0
  return Math.round((e.getTime() - s.getTime()) / 86_400_000) + 1
}

/** 校验回测区间跨度（单段按周期上限 / 多段按段数×上限），合法返回 null。
 * 起止为空的场景由调用方先行判断。 */
export function validateBacktestRange(input: {
  startDate: string
  endDate: string
  timeframe: string
  multiSegment?: boolean
  segmentCount?: number
}): string | null {
  const s = new Date(input.startDate)
  const e = new Date(input.endDate)
  if (e < s) return "结束日期不能早于开始日期"
  const max = maxDaysFor(input.timeframe)
  if (input.multiSegment) {
    if (input.timeframe === "1d") return "日线不支持多段回测，请切换分钟周期"
    const segments = input.segmentCount ?? SEGMENT_MIN_COUNT
    const min = multiSegmentMinDays(input.timeframe, segments)
    if (inclusiveDays(input.startDate, input.endDate) < min) {
      return `${input.timeframe} 周期 ${segments} 段回测区间至少 ${min} 天（每段 ${max} 天）`
    }
    return null
  }
  if ((e.getTime() - s.getTime()) / 86_400_000 > max) {
    return `${input.timeframe} 周期回测区间最多 ${max} 天`
  }
  return null
}

/** 周期 → 最大回测天数 */
export function maxDaysFor(timeframe: string): number {
  return TIMEFRAME_MAX_DAYS[timeframe] ?? DEFAULT_MAX_DAYS
}

/** YYYY-MM-DD */
export function toISO(d: Date): string {
  return d.toISOString().slice(0, 10)
}

/** 解析 YYYY-MM-DD 为 Date（UTC，避免时区偏移） */
export function parseISO(s: string): Date {
  const [y, m, d] = s.slice(0, 10).split("-").map(Number)
  return new Date(Date.UTC(y, (m || 1) - 1, d || 1))
}

/** 时间尺起点 Date（默认固定起点；数据渠道模式下由调用方传渠道最早日期） */
export function railStartFor(startISO: string = RAIL_START_ISO): Date {
  return parseISO(startISO)
}

/** 时间尺总跨度（自然天）：从起点到 today 随今天动态增长；
 * 至少保证有 maxDays 的滑动空间，避免起点逼近 today 时尺过短。 */
export function railDaysFor(
  timeframe: string,
  today: Date,
  railStart: Date = railStartFor(),
): number {
  const days = Math.round((today.getTime() - railStart.getTime()) / 86_400_000)
  return Math.max(days, maxDaysFor(timeframe) * 2)
}

/** 给定周期，返回推荐的初始区间 [start, end]（最近可用） */
export function defaultRangeFor(
  timeframe: string,
  today: Date,
): { start: string; end: string } {
  const max = maxDaysFor(timeframe)
  const end = new Date(today)
  const start = new Date(today)
  start.setUTCDate(start.getUTCDate() - max)
  return { start: toISO(start), end: toISO(end) }
}
