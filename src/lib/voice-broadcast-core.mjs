/**
 * 语音播报纯逻辑 —— 单一真相源（node:test 覆盖）
 *
 * 需求（2026-09-02 个人设置-语音播报）：
 * - 最多 4 个品种；周期 1/5/10/15/30/60 分钟
 * - 周期按整分墙钟对齐（1m 在每分钟 :00，5m 在 :00/:05…），
 *   多品种同刻到点 → 按配置顺序排队播报，间隔 1 秒
 * - 内容：品种名 + 最新价 + 涨跌幅百分比
 */

export const MAX_ITEMS = 4
export const ALLOWED_INTERVALS = [1, 5, 10, 15, 30, 60]
export const QUEUE_GAP_MS = 1000
export const MIN_RATE = 0.5
export const MAX_RATE = 2.0

export const DEFAULT_SETTINGS = Object.freeze({
  enabled: false,
  items: [],
  /** 云端音色 ID（""=自动云希）；"local"=强制本地系统语音 */
  voiceId: "",
  rate: 1.0,
})

export function isValidInterval(min) {
  return ALLOWED_INTERVALS.includes(Number(min))
}

/** 语速收敛到 [0.5, 2.0]，非法值回落 1.0 */
export function clampRate(v) {
  const n = Number(v)
  if (!Number.isFinite(n)) return 1.0
  return Math.min(MAX_RATE, Math.max(MIN_RATE, n))
}

/**
 * 周期桶号：整分墙钟对齐。
 * bucketOf(分钟边界, 5) 在 :00/:05/:10… 各跳一档；
 * 1m 与 5m 条目在每 5 分钟边界同桶 → 同刻到点排队。
 */
export function bucketOf(tsMs, intervalMin) {
  const ms = Number(intervalMin) * 60_000
  if (!Number.isFinite(ms) || ms <= 0) return NaN
  return Math.floor(Number(tsMs) / ms)
}

/**
 * 到期检测：返回本轮到点的条目（按 items 配置顺序 = 排队播报顺序），
 * 并把新桶号写回 lastBuckets（原地更新，调用方按条目持有）。
 * 首次见到的条目只播种当前桶不播报——页面刷新/刚启用不在整分边界，
 * 从下一个周期边界开始（即时反馈用设置页的试听按钮）。
 */
export function collectDue(items, nowMs, lastBuckets) {
  const due = []
  for (const it of items || []) {
    if (!it || !it.enabled) continue
    if (!isValidInterval(it.intervalMin)) continue
    const b = bucketOf(nowMs, it.intervalMin)
    if (!Number.isFinite(b)) continue
    const prev = lastBuckets.get(it.code)
    if (prev === undefined) {
      lastBuckets.set(it.code, b)
      continue
    }
    if (prev === b) continue
    lastBuckets.set(it.code, b)
    due.push(it)
  }
  return due
}

/**
 * 入队去重：同品种已在队列排队则跳过（语音长于周期时防堆积）。
 */
export function enqueueDedup(queue, entries) {
  const pending = new Set((queue || []).map((e) => e.code))
  const out = [...(queue || [])]
  for (const e of entries || []) {
    if (!e || !e.code || !e.text) continue
    if (pending.has(e.code)) continue
    pending.add(e.code)
    out.push(e)
  }
  return out
}

export function formatPrice(v, decimals = 2) {
  const n = Number(v)
  if (!Number.isFinite(n)) return ""
  const d = Number.isInteger(Number(decimals)) && Number(decimals) >= 0 && Number(decimals) <= 6
    ? Number(decimals)
    : 2
  return n.toFixed(d)
}

/** 行情过期门槛：最新 tick 距今超过该值视为停盘/休市（含盘中短暂断流） */
export const QUOTE_STALE_MS = 180_000

/**
 * 行情是否新鲜（停盘门控，2026-09-03）：交易时段 tick 秒级到达，
 * 超过 QUOTE_STALE_MS 无新 tick = 停盘/休市/断流，跳过定时播报
 * （旧价播了也是骗人）。优先 recv_ts（本地接收秒级时间戳），
 * 缺失时回落解析 tick_time（北京时间的交易所时间）。
 */
export function isQuoteFresh(quote, nowMs, maxStaleMs = QUOTE_STALE_MS) {
  if (!quote) return false
  const rt = Number(quote.recv_ts)
  if (Number.isFinite(rt) && rt > 0) {
    return nowMs - rt * 1000 <= maxStaleMs
  }
  const tt = String(quote.tick_time || "").trim()
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(tt)) {
    const t = Date.parse(`${tt.replace(" ", "T")}+08:00`)
    if (Number.isFinite(t)) return nowMs - t <= maxStaleMs
  }
  return false
}

/**
 * 播报文案：`豆粕 最新价3012.5 上涨1.25%`
 * 无行情/无效价返回空串（调用方跳过）。
 */
export function buildBroadcastText(name, quote) {
  if (!quote) return ""
  const price = Number(quote.last_price)
  if (!Number.isFinite(price) || price <= 0) return ""
  const pct = Number(quote.change_pct)
  const priceStr = formatPrice(price, quote.decimal_places)
  const nm = String(name || quote.name || quote.symbol || "").trim()
  if (!nm) return ""
  if (!Number.isFinite(pct) || pct === 0) return `${nm} 最新价${priceStr} 持平`
  const dir = pct > 0 ? "上涨" : "下跌"
  return `${nm} 最新价${priceStr} ${dir}${Math.abs(pct).toFixed(2)}%`
}

/**
 * 配置净化：条数 ≤4、品种去重、周期合法、语速收敛、类型规整。
 * 供 localStorage 读取与 UI 写入双侧使用。
 */
export function sanitizeSettings(raw) {
  const src = raw && typeof raw === "object" ? raw : {}
  const items = []
  const seen = new Set()
  for (const it of Array.isArray(src.items) ? src.items : []) {
    if (!it || typeof it !== "object") continue
    const code = String(it.code || "").trim().toUpperCase()
    if (!code || seen.has(code)) continue
    if (!isValidInterval(it.intervalMin)) continue
    seen.add(code)
    items.push({
      code,
      name: String(it.name || code).trim() || code,
      intervalMin: Number(it.intervalMin),
      // 缺省开；显式假值（0/false/null）关
      enabled: it.enabled === undefined ? true : Boolean(it.enabled),
    })
    if (items.length >= MAX_ITEMS) break
  }
  return {
    enabled: Boolean(src.enabled),
    items,
    voiceId: typeof src.voiceId === "string" ? src.voiceId.slice(0, 64) : "",
    rate: clampRate(src.rate),
  }
}
