/**
 * 成交量分布纯逻辑 —— 单一真相源（node:test 覆盖）
 *
 * 口径与 web 服务端 trade_tick_svc.py / volume_profile_ticks 完全同源：
 * - collectTick：从 WS orderbook/quote 快照提取单秒 tick
 *   （current_volume 单秒增量 + last_direction + oi_delta 持仓变化）
 * - splitOpenClose：四路开平估算（开仓率比例分摊，欠定方程对称近似）
 * - applyTick：按价格档增量聚合（buy_total/sell_total 派生）
 * - tradingDayOfBj：交易日归属（北京 21:00 后归次日 + 跳周末）
 *
 * 桌面端本地化：数据不经远端 REST，由引擎（volume-profile-engine）
 * 逐秒采集本地聚合，IndexedDB 按交易日持久化，重启/刷新不丢。
 */

/** 单价格档累积器（四路开平缺失时按 0 聚合，unknown 归入 total） */
export interface VolumeProfileRowAcc {
  price: number
  open_long: number
  close_long: number
  open_short: number
  close_short: number
  total: number
}

/** 单品种当日聚合态（rows 以价格档字符串键索引） */
export interface VolumeProfileAcc {
  rows: Record<string, VolumeProfileRowAcc>
  /** 最新一笔成交时间（北京时间 "YYYY-MM-DDTHH:mm:ss"），无数据 null */
  asof: string | null
  /** 最新一笔成交价（"最新价置顶"排序锚点），无数据 null */
  last_price: number | null
}

/** 引擎采集的单秒 tick（四路开平可缺） */
export interface VolumeTick {
  symbol: string
  direction: "buy" | "sell" | ""
  volume: number
  price: number
  /** 北京时间 "YYYY-MM-DDTHH:mm:ss"（采样时刻） */
  occurredAt: string
  split: {
    openLong: number
    closeLong: number
    openShort: number
    closeShort: number
  } | null
}

/** orderbook 快照的最小输入面（stats 字段服务端统一计算，value 可为包装或裸值） */
export interface TickOrderBook {
  symbol: string
  last_direction?: string | null
  stats?: Record<string, unknown> | null
}

/** 北京时区偏移毫秒数 */
const _BJ_OFFSET_MS = 8 * 3_600_000

/** 空聚合态 */
export function emptyAcc(): VolumeProfileAcc {
  return { rows: {}, asof: null, last_price: null }
}

/**
 * 当前归属交易日（"YYYY-MM-DD"，北京时间口径）。
 * 规则与 web 服务端 get_trading_day 一致：
 * - 00:00~20:59 归属当日；21:00~23:59 归属下一自然日
 * - 跳过周末：周五 21:00 起 → 下周一；周六/周日 → 下周一
 */
export function tradingDayOfBj(now: Date): string {
  const bj = new Date(now.getTime() + _BJ_OFFSET_MS)
  const y = bj.getUTCFullYear()
  const m = bj.getUTCMonth()
  const d = bj.getUTCDate()
  let day = new Date(Date.UTC(y, m, d))
  if (bj.getUTCHours() >= 21) day.setUTCDate(day.getUTCDate() + 1)
  const dow = day.getUTCDay()
  if (dow === 6) day.setUTCDate(day.getUTCDate() + 2)
  else if (dow === 0) day.setUTCDate(day.getUTCDate() + 1)
  return `${day.getUTCFullYear()}-${String(day.getUTCMonth() + 1).padStart(2, "0")}-${String(day.getUTCDate()).padStart(2, "0")}`
}

/** 北京时间 "YYYY-MM-DDTHH:mm:ss"（本地采集时间戳格式） */
export function bjTimestamp(now: Date): string {
  const bj = new Date(now.getTime() + _BJ_OFFSET_MS)
  const p = (n: number): string => String(n).padStart(2, "0")
  return `${bj.getUTCFullYear()}-${p(bj.getUTCMonth() + 1)}-${p(bj.getUTCDate())}T${p(bj.getUTCHours())}:${p(bj.getUTCMinutes())}:${p(bj.getUTCSeconds())}`
}

/**
 * 将单秒主动买/卖量按持仓变化估算拆分为 开多/平多/开空/平空。
 * 与 web 服务端 split_open_close 同口径：
 * - 开多 + 平空 = 主动买量；开空 + 平多 = 主动卖量
 * - 开仓率 r = (ΔOI + 总成交) / (2×总成交)，钳到 [0,1]
 * - oiDelta 缺失或无成交时无法拆分，返回 null
 */
export function splitOpenClose(
  volBuy: number,
  volSell: number,
  oiDelta: number | null,
): { openLong: number; closeLong: number; openShort: number; closeShort: number } | null {
  if (oiDelta === null) return null
  const total = volBuy + volSell
  if (total <= 0) return null
  const ratio = Math.min(Math.max((oiDelta + total) / (2 * total), 0), 1)
  const openLong = Math.min(Math.max(Math.round(volBuy * ratio), 0), volBuy)
  const closeShort = volBuy - openLong
  const openShort = Math.min(Math.max(Math.round(volSell * ratio), 0), volSell)
  const closeLong = volSell - openShort
  return { openLong, closeLong, openShort, closeShort }
}

/** 读 orderbook.stats[key]，兼容 {value} 包装与裸值（与 web _stat_value 同款） */
function statValue(ob: TickOrderBook, key: string): number | string | null {
  const stats = ob.stats
  if (!stats || typeof stats !== "object") return null
  const field = stats[key]
  if (field && typeof field === "object" && "value" in field) {
    const v = (field as { value: number | string | null }).value
    return v ?? null
  }
  if (typeof field === "number" || typeof field === "string") return field
  return null
}

/** 整数校验（bool 在 JS 中是数字子类型，显式排除——与 web isinstance(int) 口径一致） */
function asInt(v: number | string | null): number | null {
  if (typeof v === "boolean") return null
  if (typeof v === "string") {
    const n = Number(v)
    return Number.isInteger(n) ? n : null
  }
  if (typeof v === "number") return Number.isInteger(v) ? v : null
  return null
}

/**
 * 从 orderbook + 最新价提取一行 tick；该秒无成交（current_volume<=0）
 * 或缺价格时返回 null。与 web 服务端 collect_tick 同口径。
 */
export function collectTick(
  ob: TickOrderBook,
  lastPrice: number | null,
  occurredAt: string,
): VolumeTick | null {
  const symbol = String(ob.symbol || "").trim().toLowerCase()
  if (!symbol) return null
  const currentVolume = asInt(statValue(ob, "current_volume"))
  if (currentVolume === null || currentVolume <= 0) return null
  const direction = String(ob.last_direction || "").trim().toLowerCase()
  const dir: "buy" | "sell" | "" = direction === "buy" || direction === "sell" ? direction : ""
  const price = Number.isFinite(Number(lastPrice)) ? Number(lastPrice) : 0
  if (price <= 0) return null
  // 价格按 4 位小数收敛浮点尾差（web 服务端按品种 tick 取整；桌面端
  // last_price 本身即合法成交价，仅需防浮点表示误差让同价落同档）
  const roundedPrice = Number(price.toFixed(4))
  const rawOi = statValue(ob, "oi_delta")
  const oiDelta = typeof rawOi === "boolean" ? null : asInt(rawOi)
  let split: VolumeTick["split"] = null
  if (dir && oiDelta !== null) {
    split = splitOpenClose(
      dir === "buy" ? currentVolume : 0,
      dir === "sell" ? currentVolume : 0,
      oiDelta,
    )
  }
  return { symbol, direction: dir, volume: currentVolume, price: roundedPrice, occurredAt, split }
}

/** 单 tick 增量并入聚合态（纯函数：返回新态，不改入参） */
export function applyTick(acc: VolumeProfileAcc, tick: VolumeTick): VolumeProfileAcc {
  const key = String(tick.price)
  const prev = acc.rows[key]
  const row: VolumeProfileRowAcc = prev
    ? { ...prev, total: prev.total + tick.volume }
    : {
        price: tick.price,
        open_long: 0,
        close_long: 0,
        open_short: 0,
        close_short: 0,
        total: tick.volume,
      }
  if (tick.split) {
    row.open_long += tick.split.openLong
    row.close_long += tick.split.closeLong
    row.open_short += tick.split.openShort
    row.close_short += tick.split.closeShort
  }
  return {
    rows: { ...acc.rows, [key]: row },
    asof: tick.occurredAt,
    last_price: tick.price,
  }
}

/** 聚合输出行（在累积器字段上补 buy_total/sell_total 派生列） */
export interface VolumeProfileRowOut extends VolumeProfileRowAcc {
  buy_total: number
  sell_total: number
}

/** 聚合态 → price 升序行列表（补 buy_total/sell_total 派生列） */
export function profileRows(acc: VolumeProfileAcc): VolumeProfileRowOut[] {
  return Object.values(acc.rows)
    .map((r): VolumeProfileRowOut => ({
      ...r,
      buy_total: r.open_long + r.close_short,
      sell_total: r.open_short + r.close_long,
    }))
    .sort((a, b) => a.price - b.price)
}
