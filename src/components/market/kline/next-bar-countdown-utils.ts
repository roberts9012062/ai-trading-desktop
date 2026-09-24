/**
 * 下一根 K 线倒计时：交易分钟轴算法
 *
 * 口径与后端 period_end_for_product 一致：多分钟桶按品种交易分钟轴对齐，
 * 休盘间隔（10:15-10:30、午休）不计分钟，夜盘与次日日盘共用一条轴。
 * 基准为"伪 UTC 秒"：北京墙钟视为 UTC，与 KlineBar.time 经 toTimestamp 一致。
 */

import type { KlinePeriod } from "@/types"

export const PERIOD_MINUTES: Partial<Record<KlinePeriod, number>> = {
  "1m": 1,
  "5m": 5,
  "15m": 15,
  "30m": 30,
  "60m": 60,
}

/** 18:00 后开始的节段视为夜盘（国内夜盘最早 21:00 开、日盘最晚 15:15 收） */
const NIGHT_SEG_THRESHOLD_MIN = 18 * 60

/** "HH:MM" → 分钟数 */
function parseHm(hm: string): number {
  const [h, m] = hm.split(":").map(Number)
  return (h || 0) * 60 + (m || 0)
}

/**
 * 当前北京时间 → 伪 UTC 秒（与 KlineBar.time 经 toTimestamp 的基准一致：
 * 北京墙钟直接视为 UTC，与浏览器本地时区无关）
 */
export function nowBjPseudoSec(): number {
  return Math.floor(Date.now() / 1000) + 8 * 3600
}

const DAY_SEC = 86400

/** UTC 日序号（伪 UTC 秒所在的北京日） */
function dayIndexOf(pseudoSec: number): number {
  return Math.floor(pseudoSec / DAY_SEC)
}

/** 跳过周末到最近工作日（后端 _roll_to_weekday 同规则） */
function rollToWeekday(idx: number, forward: boolean): number {
  let cur = idx
  for (;;) {
    const dow = new Date(cur * DAY_SEC * 1000).getUTCDay() // 0=周日 6=周六
    if (dow !== 0 && dow !== 6) return cur
    cur += forward ? 1 : -1
  }
}

type AxisSeg = { start: number; end: number }

/**
 * 重建 at 所属交易日的交易分钟轴：夜盘挂前一自然日（回退工作日）、
 * 日盘挂次工作日，节段按开始时间排序（后端 _active_session_block 同规则）
 */
export function buildAxis(
  sessions: Array<{ start: string; end: string; cross_midnight: boolean }>,
  nowPseudo: number,
): AxisSeg[] | null {
  const segs = sessions
    .map((s) => ({ start: parseHm(s.start), end: parseHm(s.end), cross: s.cross_midnight }))
    .filter((s) => s.cross || s.end > s.start)
  if (segs.length === 0) return null

  const daySegs = segs.filter((s) => s.start < NIGHT_SEG_THRESHOLD_MIN)
  const nightSegs = segs.filter((s) => s.start >= NIGHT_SEG_THRESHOLD_MIN)

  const nowIdx = dayIndexOf(nowPseudo)
  const minutesOfDay = Math.floor((nowPseudo % DAY_SEC) / 60)

  let nightIdx: number | null = null
  let dayIdx: number
  if (nightSegs.length > 0) {
    const firstNightStart = Math.min(...nightSegs.map((s) => s.start))
    nightIdx = rollToWeekday(nowIdx - (minutesOfDay >= firstNightStart ? 0 : 1), false)
    dayIdx = rollToWeekday(nightIdx + 1, true)
  } else {
    dayIdx = rollToWeekday(nowIdx, false)
  }

  const toAbs = (seg: { start: number; end: number; cross: boolean }, idx: number): AxisSeg => {
    const start = idx * DAY_SEC + seg.start * 60
    const spanMin = seg.cross ? seg.end + 1440 - seg.start : seg.end - seg.start
    return { start, end: start + spanMin * 60 }
  }

  const axis = [
    ...(nightIdx !== null ? nightSegs.map((s) => toAbs(s, nightIdx)) : []),
    ...daySegs.map((s) => toAbs(s, dayIdx)),
  ].sort((a, b) => a.start - b.start)

  if (axis.length === 0) return null
  if (nowPseudo < axis[0].start || nowPseudo > axis[axis.length - 1].end) return null
  return axis
}

/** 轴上累计交易分钟位置 → 墙钟伪 UTC 秒 */
function axisDatetime(axis: AxisSeg[], position: number): number {
  let remaining = Math.max(position, 0)
  for (const seg of axis) {
    const dur = Math.floor((seg.end - seg.start) / 60)
    if (remaining < dur) return seg.start + remaining * 60
    if (remaining === dur) return seg.end
    remaining -= dur
  }
  return axis[axis.length - 1].end
}

/** 当前多分钟桶的结束时刻（后端 period_end_for_product 同口径，末桶钳制到闭市） */
export function bucketEndSec(axis: AxisSeg[], nowPseudo: number, minutes: number): number | null {
  const segMin = (seg: AxisSeg) => Math.floor((seg.end - seg.start) / 60)
  const totalMinutes = axis.reduce((sum, seg) => sum + segMin(seg), 0)
  let elapsed = 0
  for (const seg of axis) {
    if (nowPseudo < seg.start) break
    if (nowPseudo <= seg.end) {
      elapsed += Math.floor((nowPseudo - seg.start) / 60)
      break
    }
    elapsed += segMin(seg)
  }
  const target = Math.min((Math.floor(elapsed / minutes) + 1) * minutes, totalMinutes)
  return axisDatetime(axis, target)
}

/** 分时/日线/休市/无节段表 → null；否则返回距下一根 K 线的剩余秒数 */
export function computeRemainingSec(
  sessions: Array<{ start: string; end: string; cross_midnight: boolean }>,
  nowPseudo: number,
  minutes: number | undefined,
): number | null {
  if (!minutes || sessions.length === 0) return null
  const axis = buildAxis(sessions, nowPseudo)
  if (!axis) return null
  const end = bucketEndSec(axis, nowPseudo, minutes)
  if (end === null) return null
  const remaining = end - nowPseudo
  // 正在交易时段内时剩余必不超过一个桶长（含边界裕量）；落在段间隙
  // （午休/小憩/is_open 轮询陈旧窗口/周一凌晨幻影夜盘）时指向复市后的
  // 未来桶，直接判为不可显示——休市不启动倒计时
  if (remaining < 0 || remaining > (minutes + 1) * 60) return null
  return remaining
}
