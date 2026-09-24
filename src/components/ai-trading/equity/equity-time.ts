/**
 * AI 收益曲线时间工具（北京时间轴）
 */

import type { Time } from "lightweight-charts"
import { TickMarkType } from "lightweight-charts"

const AXIS_TZ = "Asia/Shanghai"

/** ISO / 时间串 → unix 秒 */
export function toUnixSec(iso: string): number | null {
  if (!iso) return null
  let text = iso.trim()
  if (
    !/[zZ]$/.test(text) &&
    !/[+-]\d{2}:?\d{2}$/.test(text) &&
    text.includes(" ")
  ) {
    text = `${text.replace(" ", "T")}Z`
  } else if (
    !/[zZ]$/.test(text) &&
    !/[+-]\d{2}:?\d{2}$/.test(text) &&
    /^\d{4}-\d{2}-\d{2}T/.test(text)
  ) {
    text = `${text}Z`
  }
  const ms = Date.parse(text)
  if (!Number.isFinite(ms)) return null
  return Math.floor(ms / 1000)
}

export function toChartTime(iso: string): Time | null {
  const sec = toUnixSec(iso)
  return sec === null ? null : (sec as Time)
}

export function nowUnixSec(): number {
  return Math.floor(Date.now() / 1000)
}

export function formatBj(
  unixSec: number,
  opts: Intl.DateTimeFormatOptions,
): string {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: AXIS_TZ,
    ...opts,
  }).format(new Date(unixSec * 1000))
}

export function tickMarkFormatter(
  time: Time,
  tickMarkType: TickMarkType,
  _locale: string,
): string {
  const sec = typeof time === "number" ? time : Number(time)
  if (!Number.isFinite(sec)) return ""
  switch (tickMarkType) {
    case TickMarkType.Year:
      return formatBj(sec, { year: "numeric" })
    case TickMarkType.Month:
      return formatBj(sec, { month: "short" })
    case TickMarkType.DayOfMonth:
      return formatBj(sec, { month: "2-digit", day: "2-digit" })
    case TickMarkType.Time:
      return formatBj(sec, {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      })
    case TickMarkType.TimeWithSeconds:
      return formatBj(sec, {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      })
    default:
      return formatBj(sec, {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      })
  }
}

export function crosshairTimeFormatter(time: Time): string {
  const sec = typeof time === "number" ? time : Number(time)
  if (!Number.isFinite(sec)) return ""
  return formatBj(sec, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  })
}
