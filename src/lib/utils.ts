import { type ClassValue, clsx } from "clsx"
import { twMerge } from "tailwind-merge"

/** 合并 Tailwind CSS 类名 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}

/** 格式化价格：按小数位数显示，去除尾零
 *  formatPrice(3147, 0) → "3147"
 *  formatPrice(679.1, 1) → "679.1"
 *  formatPrice(676.66, 2) → "676.66"
 */
export function formatPrice(price: number, decimalPlaces: number = 0): string {
  return Number(price.toFixed(decimalPlaces)).toString()
}

const SHANGHAI_TZ = "Asia/Shanghai"

/**
 * 解析后端时间：带 Z/+00:00 按 UTC；无时区后缀的 ISO 也按 UTC（后端 datetime.utcnow）
 */
function parseApiDate(value: string | number | Date): Date {
  if (value instanceof Date) return value
  if (typeof value === "number") return new Date(value)
  const raw = value.trim()
  // 已有时区信息
  if (/[zZ]$/.test(raw) || /[+-]\d{2}:\d{2}$/.test(raw)) {
    return new Date(raw)
  }
  // "2026-07-22T12:28:31.671282" → 视为 UTC
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(raw)) {
    return new Date(raw.endsWith("Z") ? raw : `${raw}Z`)
  }
  // "2026-07-22 12:28:31"
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(raw)) {
    return new Date(`${raw.replace(" ", "T")}Z`)
  }
  return new Date(raw)
}

/**
 * 将 API 时间（UTC ISO 或无时区）格式化为上海/北京时间字符串
 * formatShanghaiTime("2026-07-22T12:28:31.662132+00:00") → "2026-07-22 20:28:31"
 * formatShanghaiTime(iso, "time") → "20:28:31"
 */
export function formatShanghaiTime(
  value: string | number | Date | null | undefined,
  mode: "datetime" | "time" | "date" = "datetime"
): string {
  if (value === null || value === undefined || value === "") return "--"
  const date = parseApiDate(value)
  if (Number.isNaN(date.getTime())) {
    const raw = String(value)
    return raw.includes("T") ? raw.replace("T", " ").slice(0, 19) : raw.slice(0, 19)
  }

  if (mode === "time") {
    return new Intl.DateTimeFormat("zh-CN", {
      timeZone: SHANGHAI_TZ,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).format(date)
  }
  if (mode === "date") {
    return new Intl.DateTimeFormat("zh-CN", {
      timeZone: SHANGHAI_TZ,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .format(date)
      .replace(/\//g, "-")
  }

  // datetime: 2026-07-22 20:28:31
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: SHANGHAI_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date)
  const get = (type: string): string =>
    parts.find((p) => p.type === type)?.value ?? "00"
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}:${get("second")}`
}

/**
 * UI 友好时间：去掉 ISO 的 T/Z/毫秒，统一北京时间 `YYYY-MM-DD HH:mm:ss`
 *
 * - 带 Z / 时区偏移 / 纯 ISO UTC → 转上海时间
 * - 已是无时区墙钟（如 K 线 bar_time `2026-07-23 21:05:00`）→ 原样清洗，不再 +8
 */
export function formatDisplayTime(
  value: string | number | Date | null | undefined,
): string {
  if (value === null || value === undefined || value === "") return "—"
  if (value instanceof Date || typeof value === "number") {
    return formatShanghaiTime(value, "datetime")
  }
  const raw = String(value).trim()
  if (!raw) return "—"
  // 无时区墙钟（K 线 / 部分业务字段已是北京时间）
  if (
    /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(raw) &&
    !/[zZ]$/.test(raw) &&
    !/[+-]\d{2}:\d{2}$/.test(raw)
  ) {
    return raw.replace("T", " ").replace(/\.\d+$/, "").slice(0, 19)
  }
  // 仅日期
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw
  return formatShanghaiTime(raw, "datetime")
}
