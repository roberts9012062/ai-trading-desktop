/**
 * 大单预警纯函数 —— 筛选判定 / 命中判定 / 颜色与阈值辅助
 *
 * 与 UI/状态解耦的纯逻辑，供 node:test 单测覆盖。
 * TS store 与组件从这里导入，保证行为一致。
 */

/** 默认设置（与后端 server_default 对齐）——大单提醒默认全关，用户在设置面板自行开启 */
export const DEFAULT_BIG_ORDER_SETTINGS = {
  buy_enabled: false,
  buy_threshold: 100,
  buy_color: "#ef4444",
  sell_enabled: false,
  sell_threshold: 100,
  sell_color: "#22c55e",
  popup_enabled: false,
  sound_enabled: false,
  voice_enabled: false,
}

export const DEFAULT_FILTER = { direction: "all", minVolume: 0 }

/**
 * 判定单笔成交是否命中用户大单阈值。
 * direction: "buy" | "sell"；volume 为手数。
 */
export function isBigOrderHit(direction, volume, settings) {
  if (!settings) return false
  if (direction === "buy") {
    return Boolean(settings.buy_enabled) && volume >= Number(settings.buy_threshold || 0)
  }
  if (direction === "sell") {
    return Boolean(settings.sell_enabled) && volume >= Number(settings.sell_threshold || 0)
  }
  return false
}

/** 取某方向的高亮色 */
export function bigOrderColor(direction, settings) {
  if (!settings) return "#ef4444"
  return direction === "buy" ? settings.buy_color : settings.sell_color
}

/** 取某方向的阈值 */
export function bigOrderThreshold(direction, settings) {
  if (!settings) return 0
  return direction === "buy" ? settings.buy_threshold : settings.sell_threshold
}

/**
 * 成交行应用筛选：方向 + 最小手数。
 * direction: "all" | "buy" | "sell"；minVolume 0 表示不限。
 */
export function passesFilter(tradeDirection, tradeVolume, filter) {
  if (!filter) return true
  if (filter.direction !== "all" && filter.direction !== tradeDirection) {
    return false
  }
  const min = Number(filter.minVolume || 0)
  if (min > 0 && tradeVolume < min) {
    return false
  }
  return true
}

/** 当前筛选是否激活（非默认值） */
export function isFilterActive(filter) {
  if (!filter) return false
  return filter.direction !== "all" || Number(filter.minVolume || 0) > 0
}

/**
 * 北京时间交易日归属（21:00 → 次日为同一交易日）。
 * 输入 Date（视为北京时间），返回 YYYY-MM-DD 字符串。
 * 用于前端按交易日分组历史记录。
 */
export function bjTradingDay(date) {
  // date 视为北京时间；21:00 及之后归属次日
  const d = new Date(date)
  const h = d.getHours()
  let year = d.getFullYear()
  let month = d.getMonth()
  let day = d.getDate()
  if (h >= 21) {
    const next = new Date(year, month, day + 1)
    year = next.getFullYear()
    month = next.getMonth()
    day = next.getDate()
  }
  // 跳过周末：周六/周日 → 下周一
  const result = new Date(year, month, day)
  const wd = result.getDay()
  if (wd === 6) {
    result.setDate(result.getDate() + 2)
  } else if (wd === 0) {
    result.setDate(result.getDate() + 1)
  }
  const y = result.getFullYear()
  const m = String(result.getMonth() + 1).padStart(2, "0")
  const dd = String(result.getDate()).padStart(2, "0")
  return `${y}-${m}-${dd}`
}
