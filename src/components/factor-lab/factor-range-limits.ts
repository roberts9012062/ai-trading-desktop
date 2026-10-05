import { memoryTier } from "@/lib/device-profile"
import { OKX_CANDLE_FLOOR, latestOkxArchiveDay, okxArchiveDayStart } from "@/lib/okx-history"

/** 因子评估专用区间上限（默认区间与长历史滑杆共用此表）
 *
 * 分钟级按「因子实验室=短期」定位收紧并防爆（v0.2.39）:
 * 15m/30m/60m 两年(≈3.5-7 万根,与实测安全规模 7.4 万根一致)、
 * 5m 一年(≈10.5 万根)、1m 四个月(≈17.3 万根——用户想要的半年是
 * 26.2 万根,超过 20 万根 OOM 护栏:8 个分片 worker 各持全量副本,
 * 24.6 万根实测整页内存爆炸)。日线维持五年。
 * 超级因子与本表共用默认区间,同样受防爆约束。 */

/** 各内存档位的分钟级区间上限(天)——设备画像自适应,见 device-profile.ts */
const TF_MAX_DAYS_BY_TIER: Record<string, Record<string, number>> = {
  low: { "1d": 1825, "60m": 365, "30m": 365, "15m": 365, "5m": 183, "1m": 60 },
  mid: { "1d": 1825, "60m": 730, "30m": 730, "15m": 730, "5m": 365, "1m": 120 },
  high: { "1d": 1825, "60m": 1095, "30m": 1095, "15m": 730, "5m": 365, "1m": 182 },
}

const DEFAULT_MAX_DAYS = 30

/** 周期 → 因子评估最大自然天数(按本机内存档位自适应;
 *  探测一次缓存,同会话内滑杆/默认区间口径一致) */
export function factorMaxDaysFor(timeframe: string): number {
  return TF_MAX_DAYS_BY_TIER[memoryTier()][timeframe] ?? DEFAULT_MAX_DAYS
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

/** 新研究以已发布 OKX 归档为准；旧任务指定旧来源时仍可复现其窗口。 */
export function researchFactorRangeFor(timeframe: string, channel?: string): {start: string; end: string} {
  if (channel && channel !== "okx") return defaultFactorRangeFor(timeframe, new Date())
  const end = latestOkxArchiveDay()
  const start = Math.max(OKX_CANDLE_FLOOR, okxArchiveDayStart(end)-factorMaxDaysFor(timeframe)*86400000)
  return {start:new Date(start+8*3600000).toISOString().slice(0,10),end}
}
