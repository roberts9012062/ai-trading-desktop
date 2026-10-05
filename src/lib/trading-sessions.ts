/**
 * 国内期货品种交易时段配置与交易分钟轴 —— 后端 session_profiles.py / trading_hours.py 的 TS 移植
 *
 * 时间约定:全模块使用「北京时间视为 UTC」的毫秒时间戳(与 kline/utils.ts 的
 * toTimestamp 同口径)——即 fake-UTC ms,其 UTC 分量就是北京墙钟。输入输出
 * 均为该约定,由 bjNowMs() 从真实时钟换算,保证任何时区的机器结果一致。
 *
 * 移植范围:品种时段表、品种→时段映射、连续交易分钟轴(休盘间隔不计分钟)、
 * 多分钟桶起点/终点、期货交易日(夜盘归次日)、粗粒度交易时段判定。
 */

/** 节段:[开始分, 结束分](当天分钟数);结束 < 开始表示跨午夜 */
type Session = [number, number]

/** 日盘:商品(含 10:15-10:30 小节休息) */
const DAY_COMMODITY: Session[] = [
  [9 * 60, 10 * 60 + 15],
  [10 * 60 + 30, 11 * 60 + 30],
  [13 * 60 + 30, 15 * 60],
]

/** 日盘:股指 */
const DAY_INDEX: Session[] = [
  [9 * 60 + 30, 11 * 60 + 30],
  [13 * 60, 15 * 60],
]

/** 日盘:国债 */
const DAY_BOND: Session[] = [
  [9 * 60 + 30, 11 * 60 + 30],
  [13 * 60, 15 * 60 + 15],
]

const NIGHT_2300: Session[] = [[21 * 60, 23 * 60]]
const NIGHT_0100: Session[] = [[21 * 60, 1 * 60]]
const NIGHT_0230: Session[] = [[21 * 60, 2 * 60 + 30]]

interface Profile {
  label: string
  day: Session[]
  night: Session[]
}

const PROFILES: Record<string, Profile> = {
  commodity_day: { label: "商品日盘", day: DAY_COMMODITY, night: [] },
  commodity_n2300: { label: "商品+夜盘至23:00", day: DAY_COMMODITY, night: NIGHT_2300 },
  commodity_n0100: { label: "商品+夜盘至01:00", day: DAY_COMMODITY, night: NIGHT_0100 },
  commodity_n0230: { label: "商品+夜盘至02:30", day: DAY_COMMODITY, night: NIGHT_0230 },
  index: { label: "股指期货", day: DAY_INDEX, night: [] },
  bond: { label: "国债期货", day: DAY_BOND, night: [] },
}

/** 品种代码 → profile key(与后端 PRODUCT_PROFILE 一致) */
const PRODUCT_PROFILE: Record<string, string> = {
  AU: "commodity_n0230", AG: "commodity_n0230", SC: "commodity_n0230",
  CU: "commodity_n0100", AL: "commodity_n0100", ZN: "commodity_n0100",
  PB: "commodity_n0100", NI: "commodity_n0100", SN: "commodity_n0100",
  SS: "commodity_n0100", BC: "commodity_n0100", AO: "commodity_n0100",
  RB: "commodity_n2300", HC: "commodity_n2300", WR: "commodity_n2300",
  I: "commodity_n2300", J: "commodity_n2300", JM: "commodity_n2300",
  SF: "commodity_n2300", SM: "commodity_n2300",
  RU: "commodity_n2300", NR: "commodity_n2300", SP: "commodity_n2300",
  BU: "commodity_n2300", FU: "commodity_n2300", LU: "commodity_n2300",
  M: "commodity_n2300", Y: "commodity_n2300", P: "commodity_n2300",
  A: "commodity_n2300", B: "commodity_n2300", C: "commodity_n2300",
  CS: "commodity_n2300", RR: "commodity_n2300", RM: "commodity_n2300",
  OI: "commodity_n2300", CF: "commodity_n2300", CY: "commodity_n2300",
  SR: "commodity_n2300", TA: "commodity_n2300", MA: "commodity_n2300",
  FG: "commodity_n2300", SA: "commodity_n2300", PF: "commodity_n2300",
  L: "commodity_n2300", V: "commodity_n2300", PP: "commodity_n2300",
  EG: "commodity_n2300", EB: "commodity_n2300", PG: "commodity_n2300",
  PX: "commodity_n2300", SH: "commodity_n2300", BR: "commodity_n2300",
  IF: "index", IC: "index", IM: "index", IH: "index",
  T: "bond", TF: "bond", TS: "bond", TL: "bond",
  AP: "commodity_day", CJ: "commodity_day", JD: "commodity_day",
  LH: "commodity_day", SI: "commodity_day", LC: "commodity_day",
  UR: "commodity_day", WH: "commodity_day", PM: "commodity_day",
  RI: "commodity_day", RS: "commodity_day", FB: "commodity_day",
  BB: "commodity_day", EC: "commodity_day",
}

const DEFAULT_PROFILE_KEY = "commodity_n2300"

const MIN = 60_000
const DAY_MS = 86_400_000
/** 夜盘归属次交易日的分界(21:00) */
const NIGHT_CUTOFF_MIN = 21 * 60

// ========== 基础工具 ==========

/** 从合约代码提取品种代码(rb2610 → RB);后端另有合约表反查,此处用字母提取等价兜底 */
export function extractProductCode(symbol: string): string {
  const letters = symbol.trim().replace(/[^a-zA-Z]/g, "")
  return letters ? letters.toUpperCase() : "DEFAULT"
}

export function profileFor(symbolOrCode: string): Profile {
  const code = extractProductCode(symbolOrCode)
  return PROFILES[PRODUCT_PROFILE[code] ?? DEFAULT_PROFILE_KEY]
}

/**
 * 真实时钟 → fake-UTC ms(其 UTC 分量 = 北京墙钟)。
 * 必须恒定 +8h,与本机时区无关:fake-UTC 的定义就是「UTC 分量=北京钟面」,
 * 而绝对时刻的 UTC 钟面恒比北京慢 8 小时。
 * (曾误用 Date.now() + (getTimezoneOffset()+480)*MIN —— 该写法只对
 * 「本地化字符串显示」语义成立,取 UTC 分量时在 UTC+8 机器上慢 8 小时,
 * 导致引擎把盘中当休市、把服务端实时 bar 当未来脏数据,实时 K 线停更。)
 */
export function bjNowMs(): number {
  return Date.now() + 8 * 60 * MIN
}

function partsOf(ms: number) {
  const d = new Date(ms)
  return {
    y: d.getUTCFullYear(),
    mo: d.getUTCMonth(),
    d: d.getUTCDate(),
    h: d.getUTCHours(),
    mi: d.getUTCMinutes(),
    s: d.getUTCSeconds(),
    wd: d.getUTCDay(),
    tod: d.getUTCHours() * 60 + d.getUTCMinutes(),
  }
}

function dayStartMs(ms: number): number {
  const p = partsOf(ms)
  return Date.UTC(p.y, p.mo, p.d)
}

const p2 = (n: number) => String(n).padStart(2, "0")

/** fake ms → "YYYY-MM-DD HH:MM:SS"(分钟 bar 时间键,起点语义) */
export function formatMinuteTime(ms: number): string {
  const p = partsOf(ms)
  return `${p.y}-${p2(p.mo + 1)}-${p2(p.d)} ${p2(p.h)}:${p2(p.mi)}:00`
}

/** fake ms → "YYYY-MM-DD"(日线 bar 时间键) */
export function formatDayTime(ms: number): string {
  const p = partsOf(ms)
  return `${p.y}-${p2(p.mo + 1)}-${p2(p.d)}`
}

/** 统一 bar 时间键:日线只比日期,分钟线比完整时间串(后端 _bar_time_key) */
export function barTimeKey(period: string, timeStr: string): string {
  const t = String(timeStr ?? "").trim()
  if (!t) return ""
  return period === "1d" ? t.slice(0, 10) : t
}

// ========== 交易分钟轴(后端 session_profiles.py 移植) ==========

function onStartDate(session: Session, startDayMs: number): [number, number] {
  const [sMin, eMin] = session
  const sd = partsOf(startDayMs)
  const start = Date.UTC(sd.y, sd.mo, sd.d, Math.floor(sMin / 60), sMin % 60)
  const endDay = eMin < sMin ? startDayMs + DAY_MS : startDayMs
  const ed = partsOf(endDay)
  const end = Date.UTC(ed.y, ed.mo, ed.d, Math.floor(eMin / 60), eMin % 60)
  return [start, end]
}

/** at 所属交易日的连续交易分钟轴(休盘间隔不计);at 不在轴范围内 → null */
/** 向前/向后跳过周末到最近的工作日(北京日期口径,后端 _roll_to_weekday 移植) */
function rollToWeekday(ms: number, forward: boolean): number {
  for (;;) {
    const wd = partsOf(ms).wd
    if (wd !== 6 && wd !== 0) return ms
    ms += forward ? DAY_MS : -DAY_MS
  }
}

function activeSessionBlock(profile: Profile, atMs: number): [number, number][] | null {
  const day = profile.day
  const night = profile.night
  let concrete: [number, number][]

  if (night.length > 0) {
    const firstNightStart = Math.min(...night.map((s) => s[0]))
    const at = partsOf(atMs)
    // 夜盘只存在于周一~周五晚间(后端 PR #180):夜盘日回退到最近工作日
    // (周一凌晨→周五、周日→周五),日盘日为其下一工作日——绝不构造
    // 「周日晚」的幻影交易轴,否则与服务端(已修)桶起点口径分叉成双 K
    const nightDate = rollToWeekday(
      at.tod >= firstNightStart ? dayStartMs(atMs) : dayStartMs(atMs) - DAY_MS,
      false,
    )
    const dayDate = rollToWeekday(nightDate + DAY_MS, true)
    concrete = [
      ...night.map((s) => onStartDate(s, nightDate)),
      ...day.map((s) => onStartDate(s, dayDate)),
    ]
  } else {
    concrete = day.map((s) => onStartDate(s, rollToWeekday(dayStartMs(atMs), false)))
  }

  concrete.sort((a, b) => a[0] - b[0])
  if (concrete.length > 0 && concrete[0][0] <= atMs && atMs <= concrete[concrete.length - 1][1]) {
    return concrete
  }
  return null
}

/** 把累计交易分钟位置映射回实际时钟 */
function axisDatetime(
  block: [number, number][],
  position: number,
  preferNextAtBreak = false,
): number {
  let remaining = Math.max(position, 0)
  for (let i = 0; i < block.length; i++) {
    const [start, end] = block[i]
    const duration = Math.floor((end - start) / MIN)
    if (remaining < duration) return start + remaining * MIN
    if (remaining === duration) {
      if (preferNextAtBreak && i + 1 < block.length) return block[i + 1][0]
      return end
    }
    remaining -= duration
  }
  return block[block.length - 1][1]
}

/** 返回 [累计交易分钟, 当前节段末端, 上一已完成节段末端] */
function elapsedTradingMinutes(
  block: [number, number][],
  atMs: number,
): [number, number | null, number | null] {
  let elapsed = 0
  let activeEnd: number | null = null
  let previousEnd: number | null = null
  for (const [start, end] of block) {
    const duration = Math.floor((end - start) / MIN)
    if (atMs < start) break
    if (start <= atMs && atMs <= end) {
      elapsed += Math.floor((atMs - start) / MIN)
      activeEnd = end
      break
    }
    elapsed += duration
    previousEnd = end
  }
  return [elapsed, activeEnd, previousEnd]
}

/** at 所属多分钟桶在交易分钟轴上的实际起点;不在交易轴范围(休市/周末)→ null */
export function periodStartForProduct(
  productCode: string,
  atMs: number,
  minutes: number,
): number | null {
  if (minutes <= 0) return null
  const block = activeSessionBlock(profileFor(productCode), atMs)
  if (!block) return null
  const [elapsed] = elapsedTradingMinutes(block, atMs)
  return axisDatetime(block, Math.floor(elapsed / minutes) * minutes, true)
}

/** 当前多分钟 K 线按交易分钟轴的收线时刻 */
export function periodEndForProduct(
  productCode: string,
  atMs: number,
  minutes: number,
): number | null {
  if (minutes <= 0) return null
  const block = activeSessionBlock(profileFor(productCode), atMs)
  if (!block) return null
  const totalMinutes = block.reduce((acc, [s, e]) => acc + Math.floor((e - s) / MIN), 0)
  const [elapsed, activeEnd, previousEnd] = elapsedTradingMinutes(block, atMs)
  if (activeEnd !== null && atMs === activeEnd && elapsed % minutes === 0) return activeEnd
  if (activeEnd === null && elapsed % minutes === 0) return previousEnd
  const target = Math.min((Math.floor(elapsed / minutes) + 1) * minutes, totalMinutes)
  return axisDatetime(block, target)
}

/** 墙钟对齐兜底(交易轴不可用时;与后端 _get_period_start_time 的 fallback 一致) */
export function wallClockBucketMs(atMs: number, minutes: number): number {
  const p = partsOf(atMs)
  const startTotal = Math.floor(p.tod / minutes) * minutes
  return dayStartMs(atMs) + startTotal * MIN
}

/** 分钟 bar 时间串 "YYYY-MM-DD HH:MM:SS" → fake ms;格式不符 → NaN */
export function parseMinuteTimeMs(timeStr: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(String(timeStr ?? ""))
  if (!m) return NaN
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])
}

/**
 * 分钟 bar 时间是否为该周期在交易轴上的**合法桶起点**。
 * 用于剔除旧口径(墙钟/结束点语义)与脏数据:服务端 2026-08-21 才统一为
 * 交易轴起点语义,此前写入本地缓存的旧口径 bar(如 60m 的 13:00,新口径
 * 应为 13:45)会与 axis bar 并存成双 K,30m/60m 差异最大、症状最明显。
 *
 * 2026-08-24 收紧:轴不可用(span 外)一律非法——服务端(收盘聚合有日历
 * 守卫)不会再产出 span 外的墙钟桶,仍放行会让旧口径存量桶(茶歇/午休
 * 后的墙钟点,与轴点错开)在本地合并时与新轴桶并存成双 K(ma2701 15m
 * 茶歇后墙钟 10:30 vs 轴点 10:45 实测)。
 */
export function isValidMinuteBarTime(symbol: string, period: string, timeStr: string): boolean {
  const minutes = PERIOD_MINUTES_FOR_VALIDATION[period]
  if (!minutes) return true // 未知周期/日线不校验
  const ms = parseMinuteTimeMs(timeStr)
  if (!Number.isFinite(ms)) return false
  const axis = periodStartForProduct(extractProductCode(symbol), ms, minutes)
  if (axis === null) {
    return false // 轴 span 外:服务端不产桶,一律按旧口径/脏数据剔除
  }
  return axis === ms
}

const PERIOD_MINUTES_FOR_VALIDATION: Record<string, number> = {
  "1m": 1, "5m": 5, "15m": 15, "30m": 30, "60m": 60, "240m": 240,
}

// ========== 交易日 / 交易时段判定(trading_hours.py 移植) ==========

function skipWeekend(ms: number): number {
  const wd = partsOf(ms).wd
  if (wd === 6) return ms + 2 * DAY_MS // 周六 → 周一
  if (wd === 0) return ms + DAY_MS // 周日 → 周一
  return ms
}

/** 当前时间所属的期货交易日(零点,fake ms):21:00 后归次一自然日,再跳过周末 */
export function getTradingDayMs(atMs: number): number {
  const p = partsOf(atMs)
  let d = dayStartMs(atMs)
  if (p.tod >= NIGHT_CUTOFF_MIN) d += DAY_MS
  return skipWeekend(d)
}

function anySessionOpenAt(tod: number, sessions: Session[]): boolean {
  for (const [s, e] of sessions) {
    if (s <= e) {
      if (s <= tod && tod <= e) return true
    } else if (tod >= s || tod <= e) {
      return true
    }
  }
  return false
}

/** 周末休市(后端 PR #179 口径移植):夜盘只存在于周一~周五晚间——
 *  周六仅凌晨(跨午夜夜盘尾巴)可开;周日全天休市(不存在周日夜盘);
 *  周一凌晨无尾巴(周五夜盘最晚到周六凌晨)。 */
function weekendClosed(profile: Profile, atMs: number): boolean {
  const p = partsOf(atMs)
  if (p.wd === 0) return true // 周日全天
  if (p.wd === 6) {
    const inTail = profile.night.some(([s, e]) => e < s && p.tod <= e)
    return !inTail
  }
  if (p.wd === 1 && p.tod <= 2 * 60 + 30) return true // 周一凌晨
  return false
}

/** 指定合约当前是否处于交易时段(不含法定节假日日历,与后端口径一致) */
export function isSymbolTradingMs(symbol: string, atMs: number): boolean {
  const profile = profileFor(symbol)
  if (weekendClosed(profile, atMs)) return false
  const sessions = [...profile.day, ...profile.night]
  return anySessionOpenAt(partsOf(atMs).tod, sessions)
}

/** 分钟 bar 时间是否合法交易时段(后端 PR #180 口径移植):
 *  时段 09:00-11:30 / 13:00-15:15 / 21:00-02:30(跨午夜);
 *  日历:周日全天、周一凌晨、周六白天/晚间无交易(周五夜盘尾巴最晚周六凌晨)。 */
export function isMinuteBarInSession(timeStr: string): boolean {
  const raw = String(timeStr ?? "")
  const m = /(\d{2}):(\d{2})/.exec(raw)
  if (!m) return false
  const t = Number(m[1]) * 60 + Number(m[2])
  const dm = /(\d{4})-(\d{2})-(\d{2})/.exec(raw)
  if (dm) {
    const wd = new Date(
      Date.UTC(Number(dm[1]), Number(dm[2]) - 1, Number(dm[3])),
    ).getUTCDay() // bar 日期即北京日期,UTC 星期与北京一致
    if (wd === 0) return false // 周日全天
    if (wd === 6) return t <= 2 * 60 + 30 // 周六仅凌晨尾巴
    if (wd === 1 && t <= 2 * 60 + 30) return false // 周一凌晨无尾巴
  }
  if (9 * 60 <= t && t <= 11 * 60 + 30) return true
  if (13 * 60 <= t && t <= 15 * 60 + 15) return true
  if (t >= 21 * 60 || t <= 2 * 60 + 30) return true
  return false
}
