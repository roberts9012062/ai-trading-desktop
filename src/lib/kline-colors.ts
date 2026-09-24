/**
 * K线涨跌颜色自定义 —— 默认值/校验/本地持久化（与字号同模式，不依赖后端）
 */

/** 默认K线颜色：涨红 #ef4444 / 跌绿 #22c55e */
export const DEFAULT_CANDLE_UP = "#ef4444"
export const DEFAULT_CANDLE_DOWN = "#22c55e"

/** localStorage 键 */
const STORAGE_KEY = "qihuo-kline-colors"

/** 常用配色预设（涨色/跌色） */
export const KLINE_COLOR_PRESETS: Array<{
  label: string
  up: string
  down: string
}> = [
  { label: "红涨绿跌（默认）", up: "#ef4444", down: "#22c55e" },
  { label: "绿涨红跌（国际）", up: "#22c55e", down: "#ef4444" },
  { label: "红涨蓝跌", up: "#ef4444", down: "#3b82f6" },
  { label: "黄涨紫跌", up: "#f59e0b", down: "#a855f7" },
]

/** 校验 #RRGGBB 十六进制色；非法返回 null */
export function normalizeHexColor(value: unknown): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim().toLowerCase()
  if (!/^#[0-9a-f]{6}$/.test(trimmed)) return null
  return trimmed
}

export interface KlineColors {
  up: string
  down: string
}

/** 读取本地K线颜色（缺省/非法回默认） */
export function readStoredKlineColors(): KlineColors {
  if (typeof window === "undefined") {
    return { up: DEFAULT_CANDLE_UP, down: DEFAULT_CANDLE_DOWN }
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return { up: DEFAULT_CANDLE_UP, down: DEFAULT_CANDLE_DOWN }
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const up = normalizeHexColor(parsed.up)
    const down = normalizeHexColor(parsed.down)
    return { up: up ?? DEFAULT_CANDLE_UP, down: down ?? DEFAULT_CANDLE_DOWN }
  } catch {
    return { up: DEFAULT_CANDLE_UP, down: DEFAULT_CANDLE_DOWN }
  }
}

/** 保存K线颜色到本地 */
export function saveStoredKlineColors(colors: KlineColors): void {
  if (typeof window === "undefined") return
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(colors))
  } catch {
    // 存储满/隐私模式：忽略，本次会话仍生效
  }
}
