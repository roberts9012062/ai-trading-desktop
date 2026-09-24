/**
 * K 线图表纯工具：时间/周期/实时合并/悬停 bar 派生
 */

import { ColorType, type Time } from "lightweight-charts"
import type { KlineBar, KlinePeriod } from "@/types"

/** K 线周期选项 */
export const PERIODS: { value: KlinePeriod; label: string }[] = [
  { value: "tick", label: "分时" },
  { value: "1m", label: "1分" },
  { value: "5m", label: "5分" },
  { value: "15m", label: "15分" },
  { value: "30m", label: "30分" },
  { value: "60m", label: "60分" },
  { value: "1d", label: "日线" },
]

/** 时间字符串 → Unix 时间戳（秒），将北京时间视为 UTC 以确保时区无关 */
export function toTimestamp(time: string): number {
  const normalized = time.includes(" ") ? time.replace(" ", "T") : `${time}T00:00:00`
  const d = new Date(normalized + "Z")
  return Math.floor(d.getTime() / 1000)
}

/** 日线只比日期，分钟线比完整时间 */
export function normalizeBarTime(period: KlinePeriod, time: string): string {
  if (!time) return ""
  return period === "1d" ? time.split(" ")[0] : time
}

/** bar 时间 → lightweight-charts Time */
export function formatChartTime(period: KlinePeriod, time: string): Time {
  return (period === "1d" ? time.split(" ")[0] : toTimestamp(time)) as Time
}

/**
 * 按图表时间键去重（同键后者覆盖前者）
 * 修复日线 `YYYY-MM-DD` 与 `YYYY-MM-DD 00:00:00` 并存导致 setData 失败
 */
export function dedupeBarsByChartTime(
  bars: KlineBar[],
  period: KlinePeriod,
): KlineBar[] {
  if (bars.length <= 1) return bars
  const map = new Map<string, KlineBar>()
  const order: string[] = []
  for (const bar of bars) {
    const key = String(formatChartTime(period, bar.time))
    if (!key || key === "NaN") continue
    if (!map.has(key)) order.push(key)
    map.set(key, bar)
  }
  return order.map((k) => map.get(k)!).filter(Boolean)
}

/** 过滤无效 OHLC，避免 0 / NaN 把价格轴和均线拉崩 */
export function sanitizeBars(bars: KlineBar[]): KlineBar[] {
  return bars.filter((b) => {
    const o = Number(b.open)
    const h = Number(b.high)
    const l = Number(b.low)
    const c = Number(b.close)
    if (![o, h, l, c].every((n) => Number.isFinite(n) && n > 0)) return false
    return true
  })
}

/** 写入指标 series 前清洗：去重 + 过滤无效 OHLC */
export function prepareBars(bars: KlineBar[], period: KlinePeriod): KlineBar[] {
  return dedupeBarsByChartTime(sanitizeBars(bars), period)
}

/** 图表基础选项 */
export function makeChartOpts() {
  return {
    layout: {
      background: { type: ColorType.Solid, color: "#1a1a1e" },
      textColor: "#9ca3af",
      fontFamily: "-apple-system, BlinkMacSystemFont, sans-serif",
    },
    grid: { vertLines: { color: "#2e2e33" }, horzLines: { color: "#2e2e33" } },
    crosshair: {
      vertLine: { color: "#6b7280", labelBackgroundColor: "#3b82f6" },
      horzLine: { color: "#6b7280", labelBackgroundColor: "#3b82f6" },
    },
    rightPriceScale: { borderColor: "#3a3a40" },
    timeScale: {
      borderColor: "#3a3a40",
      timeVisible: true,
      // 默认右侧约一半空白（像素优先，见 scrollToLatestHalfEmpty）
      rightOffset: 40,
      rightOffsetPixels: 200,
      tickMarkFormatter: (time: number | string, tickMarkType: number) => {
        if (typeof time === "string") return time
        const d = new Date(time * 1000)
        if (tickMarkType <= 2) {
          const mm = d.getUTCMonth() + 1
          const dd = d.getUTCDate()
          return `${mm}/${dd}`
        }
        const hh = String(d.getUTCHours()).padStart(2, "0")
        const mi = String(d.getUTCMinutes()).padStart(2, "0")
        return `${hh}:${mi}`
      },
    },
    handleScale: { axisPressedMouseMove: true },
    handleScroll: { vertTouchDrag: false },
    localization: {
      timeFormatter: (time: number | string) => {
        if (typeof time === "string") {
          const [, m, d] = time.split("-")
          return `${parseInt(m)}月${parseInt(d)}日`
        }
        const d = new Date(time * 1000)
        const mm = String(d.getUTCMonth() + 1).padStart(2, "0")
        const dd = String(d.getUTCDate()).padStart(2, "0")
        const hh = String(d.getUTCHours()).padStart(2, "0")
        const mi = String(d.getUTCMinutes()).padStart(2, "0")
        const ss = String(d.getUTCSeconds()).padStart(2, "0")
        return `${mm}月${dd}日 ${hh}:${mi}:${ss}`
      },
      dateFormat: "MM月dd日",
    },
  }
}

/** 默认每根 K 占用像素 */
const HALF_EMPTY_BAR_SPACING = 8

/**
 * 切换品种/周期后：最新 K 靠中线，右侧约一半空白
 *
 * LWC v5 优先用 rightOffsetPixels（像素级，优先于 rightOffset）。
 * @param barCount 当前蜡烛数量（逻辑索引 0..barCount-1）
 */
export function scrollToLatestHalfEmpty(
  chart: {
    timeScale: () => {
      width: () => number
      applyOptions: (opts: Record<string, unknown>) => void
      setVisibleLogicalRange: (range: { from: number; to: number }) => void
      scrollToPosition: (position: number, animated: boolean) => void
      scrollToRealTime?: () => void
    }
  },
  barCount: number
): boolean {
  const ts = chart.timeScale()
  const width = ts.width()
  if (width <= 0 || barCount <= 0) return false

  // 右侧留白约一半；保证至少能看到 minVisible 根历史 K，避免视口落在空白区黑屏
  const rightPx = Math.max(80, Math.floor(width * 0.45))
  let halfBars = Math.max(16, Math.floor(rightPx / HALF_EMPTY_BAR_SPACING))
  const minVisible = Math.min(30, Math.max(10, Math.floor(barCount * 0.4)))
  if (halfBars > barCount - minVisible && barCount > minVisible) {
    halfBars = Math.max(8, barCount - minVisible)
  }
  const last = barCount - 1
  const from = Math.min(last, Math.max(-halfBars, last - halfBars))
  const to = last + halfBars

  try {
    ts.applyOptions({
      barSpacing: HALF_EMPTY_BAR_SPACING,
      minBarSpacing: 2,
      rightOffsetPixels: rightPx,
      rightOffset: halfBars,
      fixRightEdge: false,
      lockVisibleTimeRangeOnResize: false,
    })
  } catch {
    try {
      ts.applyOptions({
        barSpacing: HALF_EMPTY_BAR_SPACING,
        rightOffset: halfBars,
      })
    } catch {
      // ignore
    }
  }

  try {
    ts.setVisibleLogicalRange({ from, to })
  } catch {
    try {
      ts.scrollToPosition(halfBars, false)
    } catch {
      try {
        ts.scrollToRealTime?.()
      } catch {
        return false
      }
    }
  }
  return true
}

/** 多次重试半空布局（等 chart 布局 / setData 完成） */
export function scheduleHalfEmptyScroll(
  getChart: () =>
    | {
        timeScale: () => {
          width: () => number
          applyOptions: (opts: Record<string, unknown>) => void
          setVisibleLogicalRange: (range: { from: number; to: number }) => void
          scrollToPosition: (position: number, animated: boolean) => void
          scrollToRealTime?: () => void
        }
      }
    | null,
  barCount: number,
  delays: number[]
): () => void {
  const timers: ReturnType<typeof setTimeout>[] = []
  for (const d of delays) {
    timers.push(
      setTimeout(() => {
        const c = getChart()
        if (c && barCount > 0) scrollToLatestHalfEmpty(c, barCount)
      }, d)
    )
  }
  return () => {
    for (const t of timers) clearTimeout(t)
  }
}

/** 清除旧版视口缓存（迁移用） */
export function clearOldViewports(): void {
  const keysToRemove: string[] = []
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)
    if (key?.startsWith("kline-vp:")) keysToRemove.push(key)
  }
  keysToRemove.forEach((k) => localStorage.removeItem(k))
}

if (typeof window !== "undefined") {
  clearOldViewports()
}

/** 合并实时 bar 到历史 bar：保留历史 open 和 settle/open_interest。
 *  版本号守卫：rtBar 版本更低（乱序/重放/修正前的旧帧）时原样返回 lastBar；
 *  version 透传给图表序列，kind=correction 标记权威修正帧。 */
export function mergeRealtimeBar(lastBar: KlineBar, rtBar: KlineBar): KlineBar {
  if (
    lastBar.version !== undefined &&
    rtBar.version !== undefined &&
    rtBar.version < lastBar.version
  ) {
    return lastBar
  }
  return {
    time: rtBar.time,
    open: lastBar.open,
    high: Math.max(lastBar.high, rtBar.high),
    low: Math.min(lastBar.low, rtBar.low),
    close: rtBar.close,
    volume: rtBar.volume,
    settle: lastBar.settle,
    open_interest: lastBar.open_interest ?? lastBar.openInterest,
    version: rtBar.version ?? lastBar.version,
    ...(rtBar.kind === "correction" ? { kind: rtBar.kind } : {}),
  }
}

/**
 * 将实时 bar 合并进历史序列（同 time merge / 更新 append / 落后则忽略实时）
 * 永远返回可用数组（至少是原历史），避免调用方因 null 跳过 setData 导致黑屏
 */
export function mergeBarsWithRealtime(
  bars: KlineBar[],
  rtBar: KlineBar | undefined,
  period: KlinePeriod,
): KlineBar[] {
  if (bars.length === 0) return bars
  const base = prepareBars(bars, period)
  if (base.length === 0) return []
  if (!rtBar) return base
  if (!sanitizeBars([rtBar]).length) return base
  const barsToRender = [...base]
  const lastBar = barsToRender[barsToRender.length - 1]
  const lastT = normalizeBarTime(period, lastBar.time)
  const rtT = normalizeBarTime(period, rtBar.time)
  if (lastT === rtT) {
    barsToRender[barsToRender.length - 1] = mergeRealtimeBar(lastBar, rtBar)
    return barsToRender
  }
  if (lastT < rtT) {
    barsToRender.push(rtBar)
    return dedupeBarsByChartTime(barsToRender, period)
  }
  // 实时落后于历史：忽略实时，保留历史（分钟线常见）
  return base
}

/** 由悬停索引 + 历史/实时 bar 派生面板展示数据 */
export function resolveHoveredBar(
  barIndex: number | null,
  bars: KlineBar[],
  rtBar: KlineBar | undefined,
  period: KlinePeriod,
): KlineBar | null {
  if (barIndex === null) return null
  if (bars.length === 0) return null
  const lastHist = bars[bars.length - 1]
  const rtIsNewBar =
    rtBar !== undefined && normalizeBarTime(period, rtBar.time) > normalizeBarTime(period, lastHist.time)

  if (barIndex === bars.length) {
    return rtIsNewBar ? (rtBar ?? null) : null
  }
  if (barIndex > bars.length - 1) return null
  const baseBar = bars[barIndex]
  if (
    barIndex === bars.length - 1 &&
    rtBar !== undefined &&
    normalizeBarTime(period, rtBar.time) === normalizeBarTime(period, baseBar.time)
  ) {
    return mergeRealtimeBar(baseBar, rtBar)
  }
  return baseBar
}

/**
 * 横轴刻度标签格式化（中文）
 * - 日线：M月D日（月初显示 M月，年初显示 YYYY年）
 * - 分钟线：H:MM（同日内）/ M月D日 H:MM（跨日边界）
 *
 * time 在 lightweight-charts 中：日线为 "YYYY-MM-DD" 字符串，
 * 分钟线为 Unix 时间戳(秒，按北京时间视为 UTC 以保持时区无关)。
 */

/** 把 Time 解析为 {y,m,d,h,mi}（按北京时间，即 UTC 取值） */
function parseTimeToParts(time: Time): { y: number; m: number; d: number; h: number; mi: number } {
  if (typeof time === "string") {
    // "YYYY-MM-DD" 或 "YYYY-MM-DD HH:MM:SS"
    const [datePart, timePart] = time.split(" ")
    const [y, m, d] = datePart.split("-").map(Number)
    let h = 0, mi = 0
    if (timePart) {
      const [hh, mm] = timePart.split(":").map(Number)
      h = hh || 0
      mi = mm || 0
    }
    return { y: y || 2000, m: m || 1, d: d || 1, h, mi }
  }
  // 数字时间戳（秒）—— 视为 UTC，直接取值即北京时间
  const ms = (time as number) * 1000
  const dt = new Date(ms + new Date().getTimezoneOffset() * 60000) // 抵消本地时区，取 UTC 分量
  return {
    y: dt.getUTCFullYear(),
    m: dt.getUTCMonth() + 1,
    d: dt.getUTCDate(),
    h: dt.getUTCHours(),
    mi: dt.getUTCMinutes(),
  }
}

/**
 * 中文横轴标签：M月D日（分钟线带时分）
 * tickMarkType: 0=Year 1=Month 2=DayOfMonth 3=Time 4=TimeWithSeconds
 */
export function chineseTickMarkFormatter(
  time: Time,
  tickMarkType: number,
  _locale: string,
): string | null {
  const { y, m, d, h, mi } = parseTimeToParts(time)
  // 0 Year
  if (tickMarkType === 0) return `${y}年`
  // 1 Month
  if (tickMarkType === 1) return `${m}月`
  // 2 DayOfMonth（日线主刻度）
  if (tickMarkType === 2) return `${m}月${d}日`
  // 3 Time / 4 TimeWithSeconds（分钟线主刻度）
  const hh = String(h).padStart(2, "0")
  const mm = String(mi).padStart(2, "0")
  return `${m}月${d}日 ${hh}:${mm}`
}
